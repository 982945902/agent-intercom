import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '.agent-intercom-install.json';
export const RUNTIME_FILES = ['endpoint.mjs', 'tools.mjs', 'codex.mjs', 'bridge.mjs', 'server.mjs', 'alma.mjs', 'package.json', 'package-lock.json'];
const ENV_VARS = ['CODEX_HOME', 'CODEX_INTERCOM_SOCKET', 'PI_CODING_AGENT_DIR', 'PI_INTERCOM_SCOPE_ID', 'INTERCOM_PACKAGE'];
const exists = (file) => fs.existsSync(file) || (() => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// Canonicalize parent directories (including macOS /tmp and /var aliases), but
// never accept a symlink as an owned installation/configuration path.
function plainPath(file) {
  if (exists(file) && fs.lstatSync(file).isSymbolicLink()) fail(`Refusing symlink path: ${file}`);
}

function canonical(file) {
  plainPath(file);
  let parent = path.dirname(file);
  const suffix = [path.basename(file)];
  while (!exists(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...suffix);
}

export function options(argv, env = process.env, home = os.homedir()) {
  let target = 'all';
  let selected = false;
  let prefix = path.join(home, '.local/lib/agent-intercom');
  let replace = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--replace-existing') replace = true;
    else if (arg === '--prefix') {
      prefix = argv[++i];
      if (!prefix || !path.isAbsolute(prefix)) fail('--prefix requires an absolute directory');
    } else if (['codex', 'alma', 'all'].includes(arg) && !selected) { target = arg; selected = true; }
    else fail(`Unknown argument: ${arg}`);
  }
  const root = canonical(path.resolve(prefix));
  const codexHome = canonical(path.resolve(env.CODEX_HOME || path.join(home, '.codex')));
  const configHome = canonical(path.resolve(env.XDG_CONFIG_HOME || path.join(home, '.config')));
  const codex = canonical(path.join(codexHome, 'config.toml'));
  const alma = canonical(path.join(configHome, 'alma/plugins/intercom-bridge'));
  for (const protectedPath of [canonical(home), canonical(SOURCE), codexHome, configHome, codex, alma]) {
    if (inside(protectedPath, root)) fail('Runtime prefix must not contain the home, source, or application configuration directories');
  }
  if (inside(root, alma) || inside(root, codexHome)) fail('Runtime prefix must be separate from application installation paths');
  for (const file of [root, codex, alma]) plainPath(file);
  return { root, codex, alma, replace, targets: target === 'all' ? ['codex', 'alma'] : [target] };
}

// This intentionally supports conventional TOML table declarations, not every TOML
// spelling. Reject ambiguous layouts before touching anything; never reserialize
// unrelated TOML or interpret approval/sandbox values.
function keys(text) {
  const values = [];
  const pattern = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)/gy;
  let cursor = 0;
  while (cursor < text.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (!match) fail('Unsupported TOML key/table spelling');
    values.push(match[1] ?? (match[2] !== undefined ? JSON.parse(`"${match[2]}"`) : match[3]));
    cursor = pattern.lastIndex;
    if (!match[4]) break;
    if (cursor === text.length) fail('Unsupported trailing dot in TOML key');
  }
  if (!values.length) fail('Empty TOML table/key');
  return values;
}

function codeOnly(line) {
  let quote = null;
  let escaped = false;
  let result = '';
  for (const char of line) {
    if (quote) {
      result += ' ';
      if (escaped) escaped = false;
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '#') break;
    else if (char === '"' || char === "'") { quote = char; result += ' '; }
    else result += char;
  }
  if (quote) fail('Unsupported multiline TOML string; edit the intercom table manually');
  return result;
}

export function locateIntercom(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const sections = [];
  let offset = 0;
  let current = [];
  let brackets = 0;
  let braces = 0;
  for (const line of lines) {
    // Triple-quoted strings require a full TOML lexer; explicitly fail closed.
    if (/^[^#]*(?:"""|''')/.test(line)) fail('Unsupported multiline TOML string; edit the intercom table manually');
    const code = codeOnly(line);
    if (!brackets && !braces && code.trim().startsWith('[')) {
      const header = line.match(/^\s*(\[\[?)(.*?)(\]\]?)\s*(?:#.*)?(?:\r?\n)?$/);
      if (!header || header[1].length !== header[3].length) fail('Unsupported TOML table declaration');
      current = keys(header[2]);
      if (header[1] === '[[' && current.length === 1 && current[0] === 'mcp_servers') fail('Unsupported mcp_servers array table');
      const target = current[0] === 'mcp_servers' && current[1] === 'intercom';
      if (target && header[1] === '[[') fail('intercom cannot be a TOML array table');
      sections.push({ start: offset, end: text.length, target, keys: current });
      if (sections.length > 1) sections.at(-2).end = offset;
    } else {
      if (!brackets && !braces && code.trim()) {
        const equal = code.indexOf('=');
        if (equal < 0) fail('Unsupported TOML assignment');
        const absolute = [...current, ...keys(line.slice(0, equal))];
        if ((absolute[0] === 'mcp_servers' && absolute.length === 1) ||
            (absolute[0] === 'mcp_servers' && absolute[1] === 'intercom' && !(current[0] === 'mcp_servers' && current[1] === 'intercom'))) {
          fail('Unsupported inline/dotted intercom configuration; use [mcp_servers.intercom]');
        }
      }
      for (const char of code) {
        if (char === '[') brackets++;
        if (char === ']') brackets--;
        if (char === '{') braces++;
        if (char === '}') braces--;
        if (brackets < 0 || braces < 0) fail('Unbalanced TOML value');
      }
    }
    offset += line.length;
  }
  if (brackets || braces) fail('Unbalanced TOML value');
  const owned = sections.filter((section) => section.target);
  const names = new Set();
  for (const section of owned) {
    const name = JSON.stringify(section.keys);
    if (names.has(name)) fail('Duplicate intercom TOML table');
    names.add(name);
  }
  if (owned.length && !names.has(JSON.stringify(['mcp_servers', 'intercom']))) fail('intercom subtables require an explicit parent table');
  if (owned.length && owned.at(-1).end - owned[0].start !== owned.reduce((sum, section) => sum + section.end - section.start, 0)) {
    fail('Interleaved intercom subtables are unsupported; keep them together');
  }
  if (!owned.length) return null;
  const start = owned[0].start;
  let end = owned.at(-1).end;
  const section = text.slice(start, end);
  const marker = section.match(/^# agent-intercom: end managed entry\r?\n/m);
  if (owned.length === 1 && marker && section.slice(marker.index + marker[0].length).split('\n').every((line) => !line.trim() || line.trimStart().startsWith('#'))) {
    end = start + marker.index + marker[0].length;
  }
  return { start, end, text: text.slice(start, end) };
}

export function codexBlock(root, node = process.execPath, newline = '\n') {
  if (!path.isAbsolute(node)) fail('Node executable must be absolute');
  return ['[mcp_servers.intercom]', `command = ${JSON.stringify(node)}`, `args = [${JSON.stringify(path.join(root, 'server.mjs'))}]`, 'enabled = true', 'tool_timeout_sec = 660', `env_vars = ${JSON.stringify(ENV_VARS)}`, '# agent-intercom: end managed entry', ''].join(newline);
}

export function configureCodex(text, installed, root, replace) {
  const entry = locateIntercom(text);
  if (installed && entry?.text !== installed.owned) fail('Codex intercom configuration has changed; refusing to overwrite user edits');
  if (!installed && entry && !replace) fail('Codex intercom entry already exists; use --replace-existing to back it up');
  const block = codexBlock(root, process.execPath, text.includes('\r\n') ? '\r\n' : '\n');
  const join = text && !text.endsWith('\n') ? '\n' : '';
  const next = entry ? text.slice(0, entry.start) + block + text.slice(entry.end) : text + join + block;
  return { text: next, state: {
    previous: installed ? installed.previous : entry?.text ?? null,
    owned: block,
    separator: installed?.separator ?? (entry ? '' : join),
    prefixHash: installed?.prefixHash ?? (entry ? null : digest(text)),
  } };
}

export function restoreCodex(text, state) {
  const entry = locateIntercom(text);
  if (!entry || entry.text !== state.owned) fail('Codex intercom configuration has changed; refusing to remove user edits');
  let before = text.slice(0, entry.start);
  if (state.separator && before.endsWith(state.separator) && digest(before.slice(0, -state.separator.length)) === state.prefixHash) {
    before = before.slice(0, -state.separator.length);
  }
  return before + (state.previous ?? '') + text.slice(entry.end);
}

export function treeHash(root, excludeMarker = false) {
  plainPath(root);
  if (!fs.lstatSync(root).isDirectory()) fail(`Expected a directory: ${root}`);
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(['root', fs.statSync(root).mode & 0o777]));
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relative && excludeMarker && name === MARKER) continue;
      const file = path.join(directory, name);
      const rel = path.join(relative, name);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) hash.update(JSON.stringify(['link', rel, fs.readlinkSync(file)]));
      else if (info.isDirectory()) { hash.update(JSON.stringify(['dir', rel, info.mode & 0o777])); visit(file, rel); }
      else if (info.isFile()) { hash.update(JSON.stringify(['file', rel, info.mode & 0o777, digest(fs.readFileSync(file))])); }
      else fail(`Unsupported special file: ${file}`);
    }
  }
  visit(root);
  return hash.digest('hex');
}

function readState(root) {
  if (!exists(root)) return null;
  if (!fs.lstatSync(root).isDirectory()) fail('Runtime destination is not a directory');
  const marker = path.join(root, MARKER);
  if (!exists(marker)) return null;
  plainPath(marker);
  let state;
  try { state = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { fail('Invalid runtime ownership marker'); }
  if (state.version !== 1 || state.root !== root || typeof state.id !== 'string' || !state.integrations || typeof state.runtimeHash !== 'string') fail('Invalid runtime ownership marker');
  return state;
}

function unchanged(root, expected, excludeMarker = false) {
  if (!exists(root) || treeHash(root, excludeMarker) !== expected) fail(`Managed directory or backup changed; preserving it: ${root}`);
}

function backupInfo(file) {
  return { path: path.join(path.dirname(file), `.${path.basename(file)}.agent-intercom-backup-${crypto.randomUUID()}`), hash: treeHash(file) };
}

function checkBackup(backup, original) {
  if (!backup) return;
  if (path.dirname(backup.path) !== path.dirname(original) || !path.basename(backup.path).startsWith(`.${path.basename(original)}.agent-intercom-backup-`)) fail('Invalid backup ownership path');
  unchanged(backup.path, backup.hash);
}

function readConfig(file) {
  plainPath(file);
  return exists(file) ? fs.readFileSync(file, 'utf8') : '';
}

function writeConfig(file, expected, content) {
  if (readConfig(file) !== expected) fail('Codex configuration changed during installation; retry');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = exists(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temporary = `${file}.agent-intercom-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, content, { mode, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}

function move(from, to) {
  plainPath(from); plainPath(to);
  if (exists(to)) fail(`Destination already exists: ${to}`);
  fs.renameSync(from, to);
}

// Removal is allowed only for a directory captured by this operation and still
// byte-for-byte/mode-for-mode identical. Never follow directory symlinks.
function removeCaptured(file, hash) {
  unchanged(file, hash);
  fs.rmSync(file, { recursive: true });
}

function transaction(operations) {
  const undo = [];
  try { operations(undo); }
  catch (error) {
    const failures = [];
    for (const rollback of undo.reverse()) { try { rollback(); } catch (failure) { failures.push(failure.message); } }
    if (failures.length) throw new Error(`${error.message}; rollback could not restore ${failures.length} path(s); preserve backups and inspect installation state`);
    throw error;
  }
}

function stageRuntime(source, root) {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(root), '.agent-intercom-stage-'));
  try {
    for (const name of RUNTIME_FILES) {
      const file = path.join(source, name);
      if (!fs.lstatSync(file).isFile()) fail(`Runtime source must be a regular file: ${name}`);
      fs.copyFileSync(file, path.join(stage, name));
    }
    const result = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: stage, stdio: 'inherit', env: process.env });
    if (result.error || result.status !== 0) fail('npm ci --omit=dev --ignore-scripts failed; no application configuration was changed');
    return stage;
  } catch (error) { removeCaptured(stage, treeHash(stage)); throw error; }
}

function stagePlugin(source, destination, root) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.agent-intercom-plugin-stage-'));
  try {
    for (const name of ['manifest.json', 'main.mjs']) {
      const file = path.join(source, 'alma-plugin', name);
      if (!fs.lstatSync(file).isFile()) fail(`Plugin source must be a regular file: ${name}`);
      fs.copyFileSync(file, path.join(stage, name));
    }
    fs.writeFileSync(path.join(stage, 'bridge-root.json'), JSON.stringify({ root }) + '\n', { mode: 0o600 });
    return stage;
  } catch (error) { removeCaptured(stage, treeHash(stage)); throw error; }
}

export function install(opts, source = SOURCE) {
  const { root, targets } = opts;
  const oldState = readState(root);
  if (oldState) unchanged(root, oldState.runtimeHash, true);
  else if (exists(root) && !opts.replace) fail('Runtime directory already exists and is not owned; use --replace-existing');
  const state = oldState ? structuredClone(oldState) : { version: 1, id: crypto.randomUUID(), root, integrations: {}, runtimeBackup: exists(root) ? backupInfo(root) : null };
  if (oldState) checkBackup(state.runtimeBackup, root);
  let codex;
  if (targets.includes('codex')) {
    const previous = state.integrations.codex;
    if (previous && previous.path !== opts.codex) fail('CODEX_HOME differs from the recorded installation; uninstall the original target first');
    const before = readConfig(opts.codex);
    codex = { before, ...configureCodex(before, previous, root, opts.replace) };
    state.integrations.codex = { path: opts.codex, ...codex.state };
  }
  let pluginBackup;
  if (targets.includes('alma')) {
    const previous = state.integrations.alma;
    if (previous && previous.path !== opts.alma) fail('XDG_CONFIG_HOME differs from the recorded installation; uninstall the original target first');
    if (previous) { unchanged(opts.alma, previous.hash); checkBackup(previous.backup, opts.alma); }
    else if (exists(opts.alma) && !opts.replace) fail('Alma plugin already exists and is not owned; use --replace-existing');
    pluginBackup = previous?.backup ?? (exists(opts.alma) && !previous ? backupInfo(opts.alma) : null);
  }
  let runtimeStage;
  let pluginStage;
  const discard = [];
  try {
    runtimeStage = stageRuntime(source, root);
    if (targets.includes('alma')) {
      pluginStage = stagePlugin(source, opts.alma, root);
      state.integrations.alma = { path: opts.alma, hash: treeHash(pluginStage), backup: pluginBackup };
    }
    state.runtimeHash = treeHash(runtimeStage);
    fs.writeFileSync(path.join(runtimeStage, MARKER), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    transaction((undo) => {
      if (exists(root)) {
        if (oldState) unchanged(root, oldState.runtimeHash, true);
        else unchanged(root, state.runtimeBackup.hash);
        const destination = oldState ? `${runtimeStage}-previous` : state.runtimeBackup.path;
        move(root, destination); undo.push(() => move(destination, root));
        if (oldState) discard.push({ path: destination, hash: treeHash(destination) });
      }
      move(runtimeStage, root); undo.push(() => move(root, runtimeStage));
      if (pluginStage) {
        if (exists(opts.alma)) {
          const previous = oldState?.integrations.alma;
          unchanged(opts.alma, previous?.hash ?? pluginBackup.hash);
          const destination = previous ? `${pluginStage}-previous` : pluginBackup.path;
          move(opts.alma, destination); undo.push(() => move(destination, opts.alma));
          if (previous) discard.push({ path: destination, hash: treeHash(destination) });
        }
        move(pluginStage, opts.alma); undo.push(() => move(opts.alma, pluginStage));
      }
      if (codex) { writeConfig(opts.codex, codex.before, codex.text); undo.push(() => writeConfig(opts.codex, codex.text, codex.before)); }
    });
    for (const old of discard) removeCaptured(old.path, old.hash);
  } finally {
    for (const stage of [runtimeStage, pluginStage]) if (stage && exists(stage)) removeCaptured(stage, treeHash(stage));
  }
}

export function uninstall(opts) {
  const state = readState(opts.root);
  if (!state) fail('No owned runtime installation found; nothing was removed');
  const next = structuredClone(state);
  const selected = opts.targets.filter((target) => state.integrations[target]);
  if (!selected.length) return;
  let codex;
  if (selected.includes('codex')) {
    const entry = state.integrations.codex;
    if (entry.path !== opts.codex) fail('CODEX_HOME differs from the recorded installation');
    const before = readConfig(entry.path);
    codex = { path: entry.path, before, after: restoreCodex(before, entry) };
    delete next.integrations.codex;
  }
  const alma = selected.includes('alma') ? state.integrations.alma : null;
  if (alma) {
    if (alma.path !== opts.alma) fail('XDG_CONFIG_HOME differs from the recorded installation');
    unchanged(alma.path, alma.hash); checkBackup(alma.backup, alma.path);
    delete next.integrations.alma;
  }
  const last = Object.keys(next.integrations).length === 0;
  if (last) { unchanged(opts.root, state.runtimeHash, true); checkBackup(state.runtimeBackup, opts.root); }
  const discard = [];
  transaction((undo) => {
    if (codex) { writeConfig(codex.path, codex.before, codex.after); undo.push(() => writeConfig(codex.path, codex.after, codex.before)); }
    if (alma) {
      unchanged(alma.path, alma.hash);
      const retired = `${alma.path}.agent-intercom-remove-${crypto.randomUUID()}`;
      move(alma.path, retired); undo.push(() => move(retired, alma.path));
      discard.push({ path: retired, hash: alma.hash });
      if (alma.backup) { move(alma.backup.path, alma.path); undo.push(() => move(alma.path, alma.backup.path)); }
    }
    if (last) {
      unchanged(opts.root, state.runtimeHash, true);
      const retired = `${opts.root}.agent-intercom-remove-${crypto.randomUUID()}`;
      move(opts.root, retired); undo.push(() => move(retired, opts.root));
      discard.push({ path: retired, hash: treeHash(retired) });
      if (state.runtimeBackup) { move(state.runtimeBackup.path, opts.root); undo.push(() => move(opts.root, state.runtimeBackup.path)); }
    } else {
      const file = path.join(opts.root, MARKER);
      const before = fs.readFileSync(file, 'utf8');
      const after = JSON.stringify(next, null, 2) + '\n';
      writeConfig(file, before, after); undo.push(() => writeConfig(file, after, before));
    }
  });
  for (const old of discard) removeCaptured(old.path, old.hash);
}
