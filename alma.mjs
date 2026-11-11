import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { Endpoint, ensureBroker } from './endpoint.mjs';
import { tools } from './tools.mjs';

export class AlmaConnection extends EventEmitter {
  constructor(base = process.env.ALMA_API_URL ?? 'http://127.0.0.1:23001') {
    super();
    this.base = new URL(base);
    if (this.base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)) throw new Error('Alma Intercom requires the local Alma HTTP service');
    this.admissions = new Map();
  }

  async request(path, method = 'GET', body) {
    const response = await fetch(new URL(path, this.base), {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Alma ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  async thread(id) {
    const rows = await this.request(`/api/threads?ids=${encodeURIComponent(id)}`);
    const thread = rows.find(row => row.id === id);
    if (!thread) throw new Error('Alma thread no longer exists');
    return thread;
  }

  async connect() {
    if (this.ready) return this.ready;
    const url = new URL('/ws/threads', this.base); url.protocol = 'ws:';
    this.socket = new WebSocket(url, { handshakeTimeout: 5000 });
    this.socket.on('message', bytes => {
      let event;
      try { event = JSON.parse(bytes.toString()); } catch { return; }
      if (event.type === 'message_added') {
        const row = event.data;
        const message = row?.message;
        if (message?.role !== 'user') return;
        for (const [id, pending] of this.admissions) {
          if (pending.threadId === row.threadId && message.parts?.some(part => part.type === 'text' && part.text === pending.text)) {
            clearTimeout(pending.timer); this.admissions.delete(id);
            pending.resolve({ state: 'queued', threadId: row.threadId, messageId: row.id });
          }
        }
      } else if (event.type === 'generation_error') {
        for (const [id, pending] of this.admissions) if (pending.threadId === event.data?.threadId) {
          clearTimeout(pending.timer); this.admissions.delete(id); pending.reject(new Error(event.data.error ?? 'Alma generation failed before admission'));
        }
      } else if (event.type === 'thread_deleted') this.emit('threadDeleted', event.data?.id ?? event.data?.threadId);
      // Do not retain or expose messages belonging to unrelated Alma threads.
    });
    const fail = error => {
      for (const { reject, timer } of this.admissions.values()) { clearTimeout(timer); reject(error); }
      this.admissions.clear(); this.emit('disconnected', error);
    };
    this.socket.on('close', () => fail(new Error('Alma connection closed; reload the Intercom plugin')));
    this.socket.on('error', fail);
    this.ready = new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    return this.ready;
  }

  async deliver(threadId, messageId, text, toolKeys) {
    await this.thread(threadId);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Alma WebSocket is not connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.admissions.delete(messageId);
        reject(new Error('Alma admission acknowledgement timed out; outcome unknown. Message is not automatically resent.'));
      }, 4000);
      this.admissions.set(messageId, { threadId, text, resolve, reject, timer });
      // Explicit steering + source avoids busy-personal-thread forking. Never
      // send replace/retry/regenerate/stop fields, or use stateless completions.
      this.socket.send(JSON.stringify({ type: 'steer_generation', data: {
        threadId, source: 'intercom', userMessage: { role: 'user', parts: [{ type: 'text', text }] },
        tools: toolKeys,
      } }), error => {
        if (!error) return;
        clearTimeout(timer); this.admissions.delete(messageId); reject(error);
      });
    });
  }

  close() { this.socket?.terminate(); }
}

export class AlmaBridge {
  constructor(pluginId, connection = new AlmaConnection()) {
    this.pluginId = pluginId;
    this.toolKeys = tools.map(tool => `plugin--${pluginId}--${tool.name}`);
    this.connection = connection;
    this.endpoints = new Map();
    this.joining = new Map();
    this.closed = false;
    connection.on('disconnected', () => { for (const endpoint of this.endpoints.values()) void endpoint.close(); });
    connection.on('threadDeleted', id => { void this.endpoints.get(id)?.close(); this.endpoints.delete(id); });
  }

  async join(id, name) {
    if (this.closed) throw new Error('Alma bridge is closed');
    if (this.joining.has(id)) await this.joining.get(id);
    const existing = this.endpoints.get(id);
    if (existing) {
      if (!existing.client.isConnected()) throw new Error('Intercom disconnected; reload the Alma plugin');
      if (name && name !== existing.identity.name) {
        await this.connection.request(`/api/threads/${encodeURIComponent(id)}`, 'PUT', { title: name, skipUpdatedAt: true });
        existing.identity.name = name; existing.client.updatePresence({ name });
      }
      return this.status(existing);
    }
    const work = this.bind(id, name); this.joining.set(id, work);
    try { return await work; } finally { this.joining.delete(id); }
  }

  async bind(id, name) {
    await this.connection.connect();
    const thread = await this.connection.thread(id);
    await ensureBroker();
    let cwd = homedir();
    if (thread.workspaceId) {
      const workspace = await this.connection.request(`/api/workspaces/${encodeURIComponent(thread.workspaceId)}`);
      if (workspace.path) cwd = workspace.path;
    }
    const identity = { id, name: name ?? thread.title ?? `alma-${id.slice(0, 8)}`, cwd, model: 'Alma', replyTool: `plugin--${this.pluginId}--intercom_reply` };
    const endpoint = new Endpoint(identity, (messageId, text) => this.connection.deliver(id, messageId, text, this.toolKeys));
    try {
      await endpoint.connect();
      if (name) await this.connection.request(`/api/threads/${encodeURIComponent(id)}`, 'PUT', { title: name, skipUpdatedAt: true });
      if (this.closed) throw new Error('Alma plugin closed during registration');
      this.endpoints.set(id, endpoint);
      return this.status(endpoint);
    } catch (error) { await endpoint.close(); throw error; }
  }

  status(endpoint) { return { connected: endpoint.client.isConnected(), identity: endpoint.identity, transport: 'alma-native-thread-steering', waiting: Boolean(endpoint.waiter) }; }

  async call(name, args, context) {
    const id = context?.threadId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || id === 'cli' || context.sessionId?.startsWith('subagent:')) throw new Error('A real Alma conversation context from the native tool hook is required');
    if (name === 'intercom_join') return this.join(id, args.name);
    if (this.joining.has(id)) await this.joining.get(id);
    const endpoint = this.endpoints.get(id);
    if (!endpoint) throw new Error('Call intercom_join in this Alma conversation first');
    if (name === 'intercom_status') return this.status(endpoint);
    if (!endpoint.client.isConnected()) throw new Error('Intercom disconnected; reload the Alma plugin');
    switch (name) {
      case 'intercom_list': return endpoint.client.listSessions();
      case 'intercom_send': return endpoint.send(args.to, args.message);
      case 'intercom_ask': return endpoint.ask(args.to, args.message, args.timeout_ms ?? 300000);
      case 'intercom_reply': return endpoint.reply(args.reply_to, args.message);
      case 'intercom_pending': return endpoint.pending();
      default: throw new Error(`Unknown Intercom tool: ${name}`);
    }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.endpoints.values()].map(endpoint => endpoint.close()));
    this.endpoints.clear(); this.connection.close();
  }
}
