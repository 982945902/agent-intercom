import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionSdk, IntercomError, type ControlSdk, type IncomingDelivery, type SessionSdk } from '../../sdk/index.js';
import { connectLocal, createLocalControlSdk, readServiceToken, runtimeDirectory, type LocalTransport } from '../../sdk/node.js';

const serviceName = 'joyme-watch';
const timeoutMs = 3000;
const receiptPollMs = 100;

type SessionInfo = { id: string; name: string };
type InboundMessage = { id: string; expectsReply: boolean; content: { text: string } };
type SendResult = { id: string; delivered: boolean; reason?: string };

interface Connection {
  transport: LocalTransport;
  sdk: SessionSdk;
  control: ControlSdk;
  stop: AbortController;
}

// The older channel also accepts global maintenance commands and explicit watch IDs.
// A session using the shared service can only manage its own subscriptions.
function isSubscriberCommand(text: string, subscriberId: string): boolean {
  const command = text.trim();
  if (command.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(command); } catch { return true; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    const fields = parsed as Record<string, unknown>;
    const action = typeof fields.action === 'string' ? fields.action.trim().toLowerCase() : '';
    const global = fields.scope === 'global' || fields.global === true;
    if (['list', 'status'].includes(action) && (global || fields.all === true)) return false;
    if (['unwatch', 'stop', 'cancel', 'remove'].includes(action) && global) return false;
    const watchId = typeof fields.watch_id === 'string' ? fields.watch_id : fields.watchId;
    return typeof watchId !== 'string' || !watchId.trim() || watchId.trim().startsWith(`${subscriberId}::`);
  }
  const [verb, ...args] = command.split(/\s+/);
  const action = verb.toLowerCase();
  if (['list', 'status', 'ls'].includes(action)) return !args.includes('all');
  const positional = args.filter(arg => arg.indexOf('=') <= 0);
  return !(['unwatch', 'stop', 'cancel'].includes(action) && positional[0]?.toLowerCase() === 'all' && positional.includes('global'));
}

// The installed channel calls this before connecting. The v2 CLI manages daemon startup.
export async function ensureBroker(): Promise<void> {
  createLocalControlSdk();
}

export class IntercomClient extends EventEmitter<{
  message: [SessionInfo, InboundMessage];
  disconnected: [Error];
  error: [unknown];
}> {
  private stop?: AbortController;
  private connection?: Connection;
  private acknowledgement?: { messageId: string; accepted: boolean };

  async connect(session: Record<string, unknown>, _sessionId?: string): Promise<void> {
    if (this.stop) throw new IntercomError('SESSION_IN_USE', 'JoyME Watch already has a connection');
    const directory = runtimeDirectory();
    const control = createLocalControlSdk(directory);
    const serviceToken = readServiceToken(directory);
    const stop = new AbortController();
    const deadline = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
    this.stop = stop;
    let transport: LocalTransport | undefined;
    try {
      const socket = await connectLocal(join(directory, 'daemon.sock'), event => {
        // The channel installs its active client after awaiting connect().
        setImmediate(() => {
          const connection = this.connection;
          if (connection?.stop !== stop) return;
          void this.receive(connection, event).catch(error => {
            if (this.connection === connection && this.listenerCount('error')) this.emit('error', error);
          });
        });
      }, deadline);
      transport = socket;
      const sdk = createSessionSdk({
        request(operation, input, signal) {
          return socket.request(operation, input, AbortSignal.any([stop.signal, signal ?? AbortSignal.timeout(timeoutMs)]));
        },
      });
      const cwd = typeof session.cwd === 'string' ? session.cwd : undefined;
      await sdk.join({ adapterKind: 'service', hostInstanceId: 'local', nativeSessionId: serviceName, name: serviceName, cwd }, serviceToken);
      stop.signal.throwIfAborted();
      this.connection = { transport: socket, sdk, control, stop };
      void socket.closed.then(() => {
        if (this.stop !== stop) return;
        this.connection = undefined;
        this.stop = undefined;
        stop.abort();
        this.emit('disconnected', new IntercomError('UNAVAILABLE', 'Intercom v2 connection closed'));
      });
    } catch (error) {
      stop.abort();
      transport?.close();
      await transport?.closed;
      if (this.stop === stop) this.stop = undefined;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.stop?.abort();
    this.stop = undefined;
    connection?.transport.close();
    await connection?.transport.closed;
  }

  isConnected(): boolean {
    return this.connection !== undefined;
  }

  async listSessions(options: { timeoutMs?: number } = {}): Promise<SessionInfo[]> {
    const peers = await this.requireConnection().sdk.listPeers(AbortSignal.timeout(options.timeoutMs ?? timeoutMs));
    return peers.map(({ id, name }) => ({ id, name }));
  }

  async send(to: string, { text, replyTo }: { text: string; replyTo?: string }): Promise<SendResult> {
    const { sdk, control, stop } = this.requireConnection();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([stop.signal, deadline]);
    let id = '';
    try {
      let record = replyTo ? await sdk.reply({ replyTo, text }, signal) : await sdk.send({ to, text }, signal);
      id = record.message.id;
      for (;;) {
        const delivery = record.deliveries.find(item => item.toSessionId === to);
        if (!delivery) return { id, delivered: false, reason: 'Intercom did not record a delivery to this subscriber' };
        if (delivery.state === 'host_accepted') return { id, delivered: true };
        if (delivery.state !== 'queued' && delivery.state !== 'adapter_received') {
          return { id, delivered: false, reason: delivery.detail ?? `Intercom delivery ${delivery.state}` };
        }
        await delay(receiptPollMs, undefined, { signal });
        record = await control.getMessage({ messageId: id }, signal);
      }
    } catch (error) {
      const reason = stop.signal.aborted ? 'Intercom v2 connection closed'
        : deadline.aborted ? 'Intercom did not confirm host acceptance before the deadline'
        : error instanceof Error ? error.message : String(error);
      return { id, delivered: false, reason };
    }
  }

  sendMessageReceipt({ messageId, status }: { messageId: string; status: string; timestamp: number }): void {
    if (status === 'acknowledged' && this.acknowledgement?.messageId === messageId) {
      this.acknowledgement.accepted = true;
    }
  }

  private async receive(connection: Connection, { message, delivery }: IncomingDelivery): Promise<void> {
    const receipt = { deliveryId: delivery.id, source: 'service' };
    await connection.sdk.receipt({ ...receipt, state: 'adapter_received' });
    if (this.connection !== connection) return;
    if (!isSubscriberCommand(message.text, message.fromSessionId)) {
      await connection.sdk.receipt({ ...receipt, state: 'rejected', detail: 'JoyME Watch commands are scoped to the subscribing session' });
      return;
    }
    const acknowledgement = { messageId: message.id, accepted: false };
    this.acknowledgement = acknowledgement;
    try {
      this.emit('message', { id: message.fromSessionId, name: message.fromName }, {
        id: message.id,
        expectsReply: message.kind === 'ask',
        content: { text: message.text },
      });
    } catch (error) {
      void connection.sdk.receipt({ ...receipt, state: 'delivery_unknown', detail: 'JoyME Watch command handler threw' }).catch(() => {});
      throw error;
    } finally {
      this.acknowledgement = undefined;
    }
    if (acknowledgement.accepted) await connection.sdk.receipt({ ...receipt, state: 'host_accepted' });
    else await connection.sdk.receipt({ ...receipt, state: 'rejected', detail: 'JoyME Watch did not acknowledge the command' });
  }

  private requireConnection(): Connection {
    if (!this.connection) throw new IntercomError('UNAVAILABLE', 'JoyME Watch is not connected to Intercom v2');
    return this.connection;
  }
}
