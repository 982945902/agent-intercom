import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// The daemon control socket speaks WebSocket, not newline-delimited stdio JSON.
export class CodexConnection extends EventEmitter {
  constructor(socketPath = process.env.CODEX_INTERCOM_SOCKET ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock')) {
    super();
    this.socketPath = socketPath;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open();
    try { await this.ready; } catch (error) { this.close(); throw error; }
  }

  async open() {
    this.socket = new WebSocket(`ws+unix://${this.socketPath}:/`, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    this.socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); }
      catch { this.fail(new Error('Invalid JSON from Codex daemon')); return; }
      if ('method' in message) {
        // Never answer shared server requests, even with an error: the owning
        // TUI must retain the human's approval decision.
        if ('id' in message) this.emit('serverRequest', message);
        else this.emit('notification', message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.on('close', () => this.fail(new Error('Codex daemon connection closed')));
    this.socket.on('error', error => this.fail(error));
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    await this.call('initialize', { clientInfo: { name: 'agent_intercom', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  }

  call(method, params = {}, timeout = 15000) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex daemon is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; outcome unknown. No automatic retry.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  fail(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('disconnected', error);
  }

  close() {
    this.socket?.terminate();
    this.ready = null;
    this.fail(new Error('Intercom connection closed'));
  }
}
