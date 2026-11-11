import { CodexConnection } from './codex.mjs';
import { Endpoint, ensureBroker } from './endpoint.mjs';

export class Bridge {
  constructor(codex = new CodexConnection()) {
    this.codex = codex;
    this.endpoint = null;
    this.binding = null;
    this.closed = false;
    codex.on('disconnected', () => { void this.endpoint?.close(); });
    codex.on('notification', ({ method, params }) => {
      if (params?.threadId !== this.endpoint?.identity.id) return;
      if (method === 'thread/status/changed') this.endpoint.client.updatePresence({ status: params.status.type });
      if (method === 'thread/closed') void this.endpoint.close();
    });
  }

  threadId(meta) {
    const id = meta?.threadId;
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
      throw new Error('Codex host _meta.threadId is required. Sender identity cannot be supplied in tool arguments.');
    }
    return id;
  }

  async loaded(threadId) {
    let cursor;
    do {
      const result = await this.codex.call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (result.data.includes(threadId)) return;
      cursor = result.nextCursor;
    } while (cursor);
    throw new Error('This thread is not loaded in the connected Codex daemon. Use the native shared-daemon Codex CLI, or set CODEX_INTERCOM_SOCKET to its actual daemon. Intercom will not resume or clone another runtime.');
  }

  async join(meta, name) {
    const id = this.threadId(meta);
    if (this.closed) throw new Error('Bridge is closed');
    if (this.binding) await this.binding;
    if (this.endpoint) {
      if (this.endpoint.identity.id !== id) throw new Error('Thread identity changed on a bound MCP connection');
      if (!this.endpoint.client.isConnected()) throw new Error('Intercom disconnected; reload this MCP server to join again');
      if (name && name !== this.endpoint.identity.name) throw new Error('Already joined under a different name; reload the MCP server before renaming');
      return this.status();
    }
    this.binding = this.bind(id, name);
    try { return await this.binding; } finally { this.binding = null; }
  }

  async bind(id, name) {
    await this.codex.connect();
    await this.loaded(id);
    const { thread } = await this.codex.call('thread/read', { threadId: id, includeTurns: false });
    await ensureBroker();
    const identity = { id, name: name ?? thread.name ?? `codex-${id.slice(0, 8)}`, cwd: thread.cwd, model: 'Codex', replyTool: 'intercom_reply' };
    const endpoint = new Endpoint(identity, async (messageId, text) => {
      await this.loaded(id);
      // add wakes idle threads and queues behind busy turns. Never also start:
      // that races the native queue. clientUserMessageId is NOT a dedupe key.
      const result = await this.codex.call('thread/queue/add', {
        threadId: id, clientUserMessageId: messageId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      return { state: 'queued', submission: result.queuedSubmission };
    });
    this.endpoint = endpoint;
    try {
      await endpoint.connect();
      if (name) await this.codex.call('thread/name/set', { threadId: id, name });
      if (this.closed) throw new Error('Bridge closed during registration');
      return this.status();
    } catch (error) {
      await endpoint.close(); this.endpoint = null; throw error;
    }
  }

  status() {
    return { connected: this.endpoint?.client.isConnected() ?? false, identity: this.endpoint?.identity ?? null, transport: 'native-codex-queue', waiting: Boolean(this.endpoint?.waiter) };
  }

  async call(name, args, meta, signal) {
    if (name === 'intercom_join') return this.join(meta, args.name);
    if (this.binding) await this.binding;
    if (!this.endpoint) throw new Error('Call intercom_join once in this Codex conversation first');
    if (this.threadId(meta) !== this.endpoint.identity.id) throw new Error('Thread identity does not match this MCP connection');
    if (name === 'intercom_status') return this.status();
    if (!this.endpoint.client.isConnected()) throw new Error('Intercom is disconnected; reload the MCP server');
    switch (name) {
      case 'intercom_list': return this.endpoint.client.listSessions();
      case 'intercom_send': return this.endpoint.send(args.to, args.message);
      case 'intercom_ask': return this.endpoint.ask(args.to, args.message, args.timeout_ms ?? 300000, signal);
      case 'intercom_reply': return this.endpoint.reply(args.reply_to, args.message);
      case 'intercom_pending': return this.endpoint.pending();
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  async close() {
    this.closed = true;
    await this.endpoint?.close();
    this.codex.close();
  }
}
