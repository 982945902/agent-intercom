import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SOURCE, MARKER, RUNTIME_FILES, configureCodex, restoreCodex, locateIntercom, options, treeHash } from './lifecycle.mjs';

const initial = '# keep this comment\nmodel = "original"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n\n[mcp_servers.other]\ncommand = "other-server" # keep inline comment\n';

test('Codex merge preserves unrelated settings/comments and later revisions', () => {
  const first = configureCodex(initial, null, '/runtime with spaces', false);
  assert.ok(first.text.startsWith(initial));
  const revised = first.text.replace('model = "original"', 'model = "revised"') + '\n# unrelated new comment\n[projects."/example"]\ntrust_level = "untrusted"\n';
  const updated = configureCodex(revised, first.state, '/runtime with spaces', false);
  assert.equal(updated.text, revised);
  assert.equal(restoreCodex(updated.text, updated.state), initial.replace('model = "original"', 'model = "revised"') + '\n# unrelated new comment\n[projects."/example"]\ntrust_level = "untrusted"\n');
});

test('Replacement restores only the original target section and contiguous subtables', () => {
  const previous = '[mcp_servers."intercom"]\ncommand = "previous"\n\n[mcp_servers.intercom.env]\nCUSTOM = "saved"\n\n';
  const suffix = '[profiles.safe]\napproval_policy = "on-request"\n';
  const text = initial + previous + suffix;
  assert.throws(() => configureCodex(text, null, '/runtime', false), /--replace-existing/);
  const installed = configureCodex(text, null, '/runtime', true);
  assert.equal(installed.state.previous, previous);
  assert.equal(restoreCodex(installed.text.replace('profiles.safe', 'profiles.revised'), installed.state), initial + previous + suffix.replace('profiles.safe', 'profiles.revised'));
});

test('Owned configuration revisions are never silently overwritten or removed', () => {
  const first = configureCodex(initial, null, '/runtime', false);
  for (const revised of [first.text.replace('enabled = true', 'enabled = false'), first.text + 'new_owned_key = true\n', first.text + '[mcp_servers.intercom.env]\nNEW = "value"\n', initial]) {
    assert.throws(() => configureCodex(revised, first.state, '/runtime', true), /configuration has changed/);
    assert.throws(() => restoreCodex(revised, first.state), /configuration has changed/);
  }
});

test('Unsupported target TOML layouts fail closed', () => {
  for (const text of [
    'mcp_servers = { intercom = { command = "old" } }\n',
    'mcp_servers.intercom.command = "old"\n',
    '[mcp_servers]\nintercom = { command = "old" }\n',
    '"mcp_servers"."intercom".command = "old"\n',
    '[[mcp_servers.intercom]]\ncommand = "old"\n',
    '[[mcp_servers]]\nother = "old"\n',
    '[mcp_servers.intercom]\ncommand = "a"\n[other]\nx = true\n[mcp_servers.intercom.env]\nX = "b"\n',
    '[mcp_servers.intercom]\ncommand = "a"\n[mcp_servers.intercom]\ncommand = "b"\n',
    'instructions = """\n[mcp_servers.intercom]\n"""\n',
    '[mcp_servers.intercom.env]\nX = "b"\n',
    '[mcp_servers.intercom]]\ncommand = "old"\n',
  ]) assert.throws(() => configureCodex(text, null, '/runtime', true), /Unsupported|unsupported|intercom|Duplicate/);
});

test('CRLF, quoted table keys and multiline arrays remain intact', () => {
  const text = '# keep\r\napproval_policy = "on-request"\r\n[mcp_servers."other"]\r\nargs = [\r\n  "[mcp_servers.intercom]", # not a table\r\n]\r\n';
  const installed = configureCodex(text, null, '/runtime', false);
  assert.equal(restoreCodex(installed.text, installed.state), text);
  assert.ok(!installed.state.owned.replaceAll('\r\n', '').includes('\n'));
  assert.equal(locateIntercom(text), null);
});

test('A missing final newline is restored without snapshotting the whole file', () => {
  const text = 'model = "original"';
  const installed = configureCodex(text, null, '/runtime', false);
  assert.equal(restoreCodex(installed.text, installed.state), text);
  assert.equal(restoreCodex(installed.text.replace('original', 'revised'), installed.state), 'model = "revised"\n');
});

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-intercom-test-'));
  const base = fs.realpathSync(temporary);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const source = path.join(base, 'source');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'alma-plugin'));
  for (const name of ['lifecycle.mjs', 'install.mjs', 'uninstall.mjs']) fs.copyFileSync(path.join(SOURCE, 'scripts', name), path.join(source, 'scripts', name));
  for (const name of RUNTIME_FILES.filter((name) => name.endsWith('.mjs'))) fs.copyFileSync(path.join(SOURCE, name), path.join(source, name));
  for (const name of ['manifest.json', 'main.mjs']) fs.copyFileSync(path.join(SOURCE, 'alma-plugin', name), path.join(source, 'alma-plugin', name));
  // A dependency-free package exercises real npm ci offline; a lifecycle hook
  // must not execute. These tests concern ownership, not the runtime protocol.
  const manifest = { name: 'installer-fixture', version: '1.0.0', private: true, scripts: { preinstall: 'node -e "require(\'node:fs\').writeFileSync(\'hook-ran\', \'unexpected\')"' } };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { '': { name: manifest.name, version: manifest.version, hasInstallScript: true } } }));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'), npm_config_cache: path.join(base, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_offline: 'true', npm_config_userconfig: path.join(base, 'empty-npmrc') };
  fs.writeFileSync(env.npm_config_userconfig, '');
  const opts = options([], env, home);
  function run(command, args = [], success = true) {
    const result = spawnSync(process.execPath, [path.join(source, 'scripts', `${command}.mjs`), ...args], { env, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (success) assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0, 'operation must refuse changes');
    return result;
  }
  fs.mkdirSync(path.dirname(opts.codex), { recursive: true });
  fs.writeFileSync(opts.codex, initial);
  return { base, home, source, opts, env, run };
}

test('First install, repeated update and partial/final uninstall use only owned paths', (t) => {
  const { opts, run } = fixture(t);
  run('install');
  assert.equal(fs.statSync(path.join(opts.root, MARKER)).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(opts.root, 'hook-ran')));
  fs.appendFileSync(opts.codex, '\n[projects."/new"]\ntrust_level = "untrusted"\n');
  run('install');
  run('uninstall', ['codex']);
  assert.ok(fs.existsSync(opts.root));
  assert.ok(fs.existsSync(opts.alma));
  assert.equal(fs.readFileSync(opts.codex, 'utf8'), initial + '\n[projects."/new"]\ntrust_level = "untrusted"\n');
  run('uninstall', ['alma']);
  assert.ok(!fs.existsSync(opts.root));
  assert.ok(!fs.existsSync(opts.alma));
});

test('Explicit replacement restores original runtime/plugin and only the Codex entry', (t) => {
  const { opts, run } = fixture(t);
  fs.mkdirSync(opts.root, { recursive: true });
  fs.writeFileSync(path.join(opts.root, 'original'), 'runtime');
  fs.mkdirSync(opts.alma, { recursive: true });
  fs.writeFileSync(path.join(opts.alma, 'original'), 'plugin');
  const oldEntry = '[mcp_servers.intercom]\ncommand = "previous"\n';
  fs.appendFileSync(opts.codex, oldEntry);
  const originalRuntime = treeHash(opts.root);
  const originalPlugin = treeHash(opts.alma);
  run('install', [], false);
  assert.equal(treeHash(opts.root), originalRuntime);
  assert.equal(treeHash(opts.alma), originalPlugin);
  assert.equal(fs.readFileSync(opts.codex, 'utf8'), initial + oldEntry);
  run('install', ['--replace-existing']);
  const state = JSON.parse(fs.readFileSync(path.join(opts.root, MARKER), 'utf8'));
  assert.equal(treeHash(state.runtimeBackup.path), originalRuntime);
  assert.equal(treeHash(state.integrations.alma.backup.path), originalPlugin);
  fs.writeFileSync(opts.codex, fs.readFileSync(opts.codex, 'utf8').replace('model = "original"', 'model = "revised"'));
  run('install', ['--replace-existing']);
  run('uninstall');
  assert.equal(treeHash(opts.root), originalRuntime);
  assert.equal(treeHash(opts.alma), originalPlugin);
  assert.equal(fs.readFileSync(opts.codex, 'utf8'), initial.replace('model = "original"', 'model = "revised"') + oldEntry);
  assert.ok(!fs.existsSync(state.runtimeBackup.path));
  assert.ok(!fs.existsSync(state.integrations.alma.backup.path));
});

test('Modified owned configuration, plugin, runtime and backup are preserved on refusal', (t) => {
  const { opts, run } = fixture(t);
  fs.mkdirSync(opts.alma, { recursive: true });
  fs.writeFileSync(path.join(opts.alma, 'original'), 'plugin');
  run('install', ['--replace-existing']);
  const installedConfig = fs.readFileSync(opts.codex, 'utf8');
  fs.writeFileSync(opts.codex, installedConfig.replace('enabled = true', 'enabled = false'));
  run('install', ['--replace-existing'], false);
  run('uninstall', [], false);
  assert.ok(fs.existsSync(opts.root));
  fs.writeFileSync(opts.codex, installedConfig);
  const extra = path.join(opts.alma, 'user-added');
  fs.writeFileSync(extra, 'preserve');
  run('uninstall', [], false);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(opts.codex, 'utf8'), installedConfig);
  fs.unlinkSync(extra);
  const runtimeExtra = path.join(opts.root, 'user-added');
  fs.writeFileSync(runtimeExtra, 'preserve');
  run('uninstall', [], false);
  assert.equal(fs.readFileSync(runtimeExtra, 'utf8'), 'preserve');
  fs.unlinkSync(runtimeExtra);
  const state = JSON.parse(fs.readFileSync(path.join(opts.root, MARKER), 'utf8'));
  fs.writeFileSync(path.join(state.integrations.alma.backup.path, 'user-added'), 'preserve backup');
  run('uninstall', [], false);
  assert.equal(fs.readFileSync(opts.codex, 'utf8'), installedConfig);
  assert.ok(fs.existsSync(opts.alma));
});

test('Unmarked and symlink destinations cannot be removed; unsafe prefixes are rejected', (t) => {
  const { base, home, opts, env, run } = fixture(t);
  fs.mkdirSync(opts.root, { recursive: true });
  fs.writeFileSync(path.join(opts.root, 'user-file'), 'preserve');
  run('uninstall', [], false);
  assert.equal(fs.readFileSync(path.join(opts.root, 'user-file'), 'utf8'), 'preserve');
  for (const prefix of [home, path.dirname(home), '/', path.dirname(opts.codex), opts.alma]) {
    assert.throws(() => options(['--prefix', prefix], env, home), /prefix/);
  }
  const link = path.join(base, 'linked-runtime');
  fs.symlinkSync(opts.root, link);
  assert.throws(() => options(['--prefix', link], env, home), /symlink/);
});

test('An explicit prefix and Codex-only install do not create the Alma plugin', (t) => {
  const { base, opts, run } = fixture(t);
  const prefix = path.join(base, 'custom runtime');
  run('install', ['codex', '--prefix', prefix]);
  assert.ok(!fs.existsSync(opts.root));
  assert.ok(!fs.existsSync(opts.alma));
  run('uninstall', ['codex', '--prefix', prefix]);
  assert.ok(!fs.existsSync(prefix));
  assert.equal(fs.readFileSync(opts.codex, 'utf8'), initial);
});
