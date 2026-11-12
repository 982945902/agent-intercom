#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Endpoint, ensureBroker } from './endpoint.mjs';
import { tools, validate } from './tools.mjs';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function agyContextFromEnv(env = process.env) {
  const conversationId = env?.ANTIGRAVITY_CONVERSATION_ID;
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
    throw new Error('AGY host ANTIGRAVITY_CONVERSATION_ID is required. Sender identity cannot be supplied in tool arguments.');
  }
  if (env?.ANTIGRAVITY_SOURCE_METADATA !== undefined && env.ANTIGRAVITY_SOURCE_METADATA !== '') {
    let source;
    try { source = JSON.parse(env.ANTIGRAVITY_SOURCE_METADATA); } catch {
      throw new Error('Invalid ANTIGRAVITY_SOURCE_METADATA from host');
    }
    const sourceConversationId = source?.tool?.conversationId;
    if (sourceConversationId !== undefined && sourceConversationId !== conversationId) {
      throw new Error('ANTIGRAVITY_CONVERSATION_ID does not match ANTIGRAVITY_SOURCE_METADATA');
    }
  }
  const lsAddress = env?.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = env?.ANTIGRAVITY_CSRF_TOKEN;
  if (typeof lsAddress !== 'string' || !lsAddress.trim() || typeof csrfToken !== 'string' || !csrfToken.trim()) {
    throw new Error('AGY host ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN are required');
  }
  return { conversationId, lsAddress: lsAddress.trim(), csrfToken: csrfToken.trim() };
}

export class AgyConnection {
  url(lsAddress, method) {
    if (typeof lsAddress !== 'string' || !lsAddress.trim()) throw new Error('AGY Language Server address is required');
    let parsed;
    try {
      parsed = new URL(lsAddress.includes('://') ? lsAddress : `http://${lsAddress}`);
    } catch {
      throw new Error('AGY Intercom requires a local HTTP Language Server address');
    }
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('AGY Intercom requires a local HTTP Language Server address');
    }
    return new URL(`/exa.language_server_pb.LanguageServerService/${method}`, parsed);
  }

  async request(lsAddress, csrfToken, method, body) {
    if (typeof csrfToken !== 'string' || !csrfToken.trim()) throw new Error('AGY CSRF token is required');
    const response = await fetch(this.url(lsAddress, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.json();
        if (payload?.message) detail = `: ${payload.message}`;
      } catch {}
      throw new Error(`AGY ${method}: HTTP ${response.status}${detail}`);
    }
    return response.json();
  }

  async conversation(lsAddress, csrfToken, id) {
    const result = await this.request(lsAddress, csrfToken, 'GetConversationMetadata', { conversationId: id });
    const metadata = result?.metadata;
    if (!metadata || typeof metadata !== 'object') throw new Error('AGY conversation no longer exists');
    if (metadata.parentConversationId || metadata.subagentSpec || (metadata.rootConversationId && metadata.rootConversationId !== id)) {
      throw new Error('Subagent conversations cannot join Intercom');
    }
    let cwd = homedir();
    const uri = metadata.workspaceUris?.[0] ?? metadata.workspaces?.[0]?.workspaceFolderAbsoluteUri;
    if (typeof uri === 'string' && uri.startsWith('file://')) {
      try { cwd = fileURLToPath(uri); } catch {}
    }
    return { id, cwd, metadata };
  }

  async deliver(lsAddress, csrfToken, id, messageId, text) {
    await this.conversation(lsAddress, csrfToken, id);
    await this.request(lsAddress, csrfToken, 'SendAgentMessage', {
      recipient: id,
      content: text,
      title: `Intercom message ${String(messageId).slice(0, 8)}`,
    });
    return { state: 'queued', conversationId: id, messageId };
  }
}

export class AgyBridge {
  constructor(connection = new AgyConnection()) {
    this.connection = connection;
    this.endpoints = new Map();
    this.joining = new Map();
    this.closed = false;
  }

  validateContext(context) {
    const id = context?.conversationId;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error('A real AGY conversation context from the host environment is required');
    }
    if (context?.sourceConversationId !== undefined && context.sourceConversationId !== id) {
      throw new Error('AGY conversation context mismatch');
    }
    this.connection.url(context?.lsAddress, 'GetConversationMetadata');
    if (typeof context?.csrfToken !== 'string' || !context.csrfToken.trim()) {
      throw new Error('AGY CSRF token is required');
    }
    return { id, lsAddress: context.lsAddress.trim(), csrfToken: context.csrfToken.trim() };
  }

  async join(context, name) {
    const { id, lsAddress, csrfToken } = this.validateContext(context);
    if (this.closed) throw new Error('AGY bridge is closed');
    if (this.joining.has(id)) await this.joining.get(id);
    const existing = this.endpoints.get(id);
    if (existing) {
      if (!existing.endpoint.client.isConnected()) {
        this.endpoints.delete(id);
        await existing.endpoint.close();
        throw new Error('Intercom disconnected; call intercom_join again');
      }
      await this.connection.conversation(lsAddress, csrfToken, id);
      existing.lsAddress = lsAddress;
      existing.csrfToken = csrfToken;
      if (name && name !== existing.endpoint.identity.name) {
        existing.endpoint.identity.name = name;
        existing.endpoint.client.updatePresence({ name });
      }
      return this.status(existing.endpoint);
    }
    const work = this.bind(id, lsAddress, csrfToken, name);
    this.joining.set(id, work);
    try { return await work; } finally { this.joining.delete(id); }
  }

  async bind(id, lsAddress, csrfToken, name) {
    const conv = await this.connection.conversation(lsAddress, csrfToken, id);
    await ensureBroker();
    const identity = {
      id,
      name: name ?? `agy-${id.slice(0, 8)}`,
      cwd: conv.cwd,
      model: 'AGY',
      replyTool: 'intercom_reply',
    };
    const entry = { endpoint: null, lsAddress, csrfToken };
    const endpoint = new Endpoint(identity, async (messageId, text) => {
      try {
        return await this.connection.deliver(entry.lsAddress, entry.csrfToken, id, messageId, text);
      } catch (error) {
        if (/HTTP 404|not_found|no longer exists/i.test(error.message)) {
          this.endpoints.delete(id);
          void entry.endpoint?.close();
        }
        throw error;
      }
    });
    entry.endpoint = endpoint;
    try {
      await endpoint.connect();
      if (this.closed) throw new Error('AGY bridge closed during registration');
      this.endpoints.set(id, entry);
      return this.status(endpoint);
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }

  status(endpoint) {
    return {
      connected: endpoint.client.isConnected(),
      identity: endpoint.identity,
      transport: 'agy-native-agentapi',
      waiting: Boolean(endpoint.waiter),
    };
  }

  async call(name, args, context, signal) {
    const { id, lsAddress, csrfToken } = this.validateContext(context);
    if (name === 'intercom_join') return this.join(context, args.name);
    if (this.joining.has(id)) await this.joining.get(id);
    const entry = this.endpoints.get(id);
    if (!entry) throw new Error('Call intercom_join once in this AGY conversation first');
    if (entry.lsAddress !== lsAddress || entry.csrfToken !== csrfToken) {
      await this.connection.conversation(lsAddress, csrfToken, id);
      entry.lsAddress = lsAddress;
      entry.csrfToken = csrfToken;
    }
    const { endpoint } = entry;
    if (name === 'intercom_status') return this.status(endpoint);
    if (!endpoint.client.isConnected()) throw new Error('Intercom is disconnected; call intercom_join again');
    switch (name) {
      case 'intercom_list': return endpoint.client.listSessions();
      case 'intercom_send': return endpoint.send(args.to, args.message);
      case 'intercom_ask': return endpoint.ask(args.to, args.message, args.timeout_ms ?? 300000, signal);
      case 'intercom_reply': return endpoint.reply(args.reply_to, args.message);
      case 'intercom_pending': return endpoint.pending();
      default: throw new Error(`Unknown Intercom tool: ${name}`);
    }
  }

  async sweep() {
    for (const [id, entry] of [...this.endpoints.entries()]) {
      try {
        await this.connection.conversation(entry.lsAddress, entry.csrfToken, id);
      } catch {
        this.endpoints.delete(id);
        await entry.endpoint.close();
      }
    }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.endpoints.values()].map(entry => entry.endpoint.close()));
    this.endpoints.clear();
  }
}

export function agySocketPath(env = process.env) {
  if (env?.AGY_INTERCOM_SOCKET) return env.AGY_INTERCOM_SOCKET;
  const base = env?.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent');
  const scope = (env?.PI_INTERCOM_SCOPE_ID ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(base, 'intercom', `agy-bridge-${scope}.sock`);
}

function resolveTool(rawName) {
  const normalized = typeof rawName === 'string' && !rawName.startsWith('intercom_') ? `intercom_${rawName}` : rawName;
  const tool = tools.find(entry => entry.name === normalized);
  if (!tool) throw new Error(`Unknown Intercom tool: ${rawName}`);
  return tool;
}

function sendSocketRequest(socketPath, payload, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error('Operation aborted by caller'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(JSON.stringify(payload) + '\n');
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch {
        return finish(reject, new Error('Invalid response from AGY Intercom daemon'));
      }
      if (!response.ok) return finish(reject, new Error(response.error ?? 'AGY Intercom daemon error'));
      finish(resolve, response.result);
    });
    socket.once('error', error => finish(reject, error));
    socket.once('close', () => {
      if (!settled) finish(reject, new Error('AGY Intercom daemon closed connection before replying'));
    });
  });
}

export async function pingAgyDaemon(socketPath = agySocketPath()) {
  try {
    await sendSocketRequest(socketPath, { type: 'ping' }, AbortSignal.timeout(1500));
    return true;
  } catch {
    return false;
  }
}

export async function startAgyDaemon(socketPath = agySocketPath(), bridge = new AgyBridge(), sweepIntervalMs = 15000) {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (await pingAgyDaemon(socketPath)) return null;
  try { unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    socket.on('error', () => controller.abort());
    socket.on('data', async chunk => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
        if (request?.type === 'ping') {
          socket.end(JSON.stringify({ ok: true, result: { pid: process.pid } }) + '\n');
          return;
        }
        const tool = resolveTool(request?.tool);
        const args = request?.args ?? {};
        validate(tool, args);
        const result = await bridge.call(tool.name, args, request?.context, controller.signal);
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) {
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  const timer = sweepIntervalMs > 0 ? setInterval(() => { void bridge.sweep(); }, sweepIntervalMs) : null;
  timer?.unref();
  let closing;
  const close = () => {
    closing ??= (async () => {
      if (timer) clearInterval(timer);
      await new Promise(resolve => server.close(() => resolve()));
      try { unlinkSync(socketPath); } catch {}
      await bridge.close();
    })();
    return closing;
  };
  return { server, bridge, socketPath, close };
}

export async function ensureAgyDaemon(socketPath = agySocketPath()) {
  if (await pingAgyDaemon(socketPath)) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon', socketPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await pingAgyDaemon(socketPath)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out starting the local AGY Intercom daemon');
}

export async function callAgyDaemon(rawToolName, args = {}, env = process.env, socketPath = agySocketPath(env), signal) {
  const tool = resolveTool(rawToolName);
  validate(tool, args);
  const context = agyContextFromEnv(env);
  await ensureAgyDaemon(socketPath);
  return sendSocketRequest(socketPath, { type: 'call', tool: tool.name, args, context }, signal);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const [, , command, rawArgs] = process.argv;
    if (command === '--daemon') {
      const daemon = await startAgyDaemon(rawArgs || agySocketPath());
      if (daemon) {
        process.once('SIGINT', () => { void daemon.close().finally(() => process.exit(0)); });
        process.once('SIGTERM', () => { void daemon.close().finally(() => process.exit(0)); });
      }
    } else {
      if (!command) throw new Error('Usage: agy.mjs <intercom_join|intercom_list|intercom_status|intercom_send|intercom_ask|intercom_reply|intercom_pending> [json-args]');
      let parsedArgs = {};
      if (rawArgs !== undefined && rawArgs.trim() !== '') {
        try { parsedArgs = JSON.parse(rawArgs); } catch {
          throw new Error('Arguments must be valid JSON');
        }
      }
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      const result = await callAgyDaemon(command, parsedArgs, process.env, agySocketPath(process.env), controller.signal);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
