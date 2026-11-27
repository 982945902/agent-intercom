import { randomUUID } from 'node:crypto';
import {
  IntercomError, parseInput, protocolVersion, systemGroupId,
  type ControlOperation, type IncomingDelivery, type Message, type MessageRecord, type Operation,
  type Parameters, type Results, type Session,
} from '../../packages/protocol/index.js';
import { Store, type StoredSession } from './store.js';

type Target = { id: string; generation: string };
type AskResult = Results['ask'];
export interface PeerConnection {
  readonly generation: string;
  sessionId?: string;
  deliver(event: IncomingDelivery): void;
}
interface WaitingAsk {
  senderId: string;
  targetId: string;
  groupId: string;
  settle(reply?: Message, error?: IntercomError): void;
}

export class Daemon {
  private readonly connections = new Map<string, PeerConnection>();
  private readonly asks = new Map<string, WaitingAsk>();

  constructor(private readonly store: Store, private readonly notify: () => void,
    private readonly authorizeService: (token: string | undefined) => boolean) {
    store.atomic(() => {
      store.disconnect();
      store.markOffline(Date.now());
    });
  }

  private online = (id: string) => this.connections.has(id);

  archiveOffline(cutoff: number) {
    if (this.store.atomic(() => this.store.archiveOffline(cutoff))) this.notify();
  }

  control(operation: ControlOperation, input: unknown): Results[ControlOperation] {
    switch (operation) {
      case 'status':
        parseInput(operation, input);
        return { protocolVersion, onlineSessions: this.connections.size, capabilities: ['sessions', 'groups', 'multi-group', 'system-services', 'messages', 'events'] };
      case 'listSessions': {
        const filters = parseInput(operation, input);
        return this.store.sessions(filters.groupId).map(session => this.presence(session))
          .filter(session => filters.online === undefined || filters.online === session.online);
      }
      case 'listGroups':
        parseInput(operation, input);
        return this.store.groups(this.online);
      case 'createGroup':
      case 'moveGroup':
      case 'addGroupMembers':
      case 'removeGroupMembers': {
        const result = this.store.changeGroup(operation, parseInput(operation, input), this.online, (id, removed) => {
          for (const ask of this.asks.values()) if (removed.includes(ask.groupId) && (ask.senderId === id || ask.targetId === id)) {
            throw new IntercomError('ACTIVE_ASK', 'Session has a pending ask in a group being removed', { sessionId: id });
          }
        });
        this.notify();
        return result;
      }
      case 'listMessages': return this.store.listMessages(parseInput(operation, input));
      case 'getMessage': return this.store.record(parseInput(operation, input).messageId);
      case 'readEvents': return this.store.events(parseInput(operation, input));
    }
  }

  session(connection: PeerConnection, operation: Exclude<Operation, ControlOperation>, input: unknown, signal: AbortSignal) {
    if (operation === 'join') return this.join(connection, parseInput(operation, input));
    const sender = connection.sessionId && this.connections.get(connection.sessionId) === connection
      ? this.store.session(connection.sessionId) : undefined;
    if (!sender) throw new IntercomError('NOT_JOINED', 'Join Intercom before using this operation');
    switch (operation) {
      case 'sessionStatus':
        parseInput(operation, input);
        return this.presence(sender);
      case 'rename': {
        const { name } = parseInput(operation, input);
        this.store.atomic(() => {
          this.store.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, sender.id);
          this.store.event('session', { groupId: sender.groupId, sessionId: sender.id, state: 'renamed' });
        });
        this.notify();
        return this.presence({ ...sender, name });
      }
      case 'listPeers': {
        parseInput(operation, input);
        const service = sender.adapterKind === 'service';
        return this.store.sessions().flatMap(peer => {
          if (peer.id === sender.id || !this.online(peer.id)) return [];
          if (service || peer.adapterKind === 'service') return [this.presence(peer)];
          const shared = this.sharedGroups(sender, peer);
          return shared.length ? [{ ...this.presence(peer), groupIds: shared,
            groupId: shared.includes(peer.groupId) ? peer.groupId : shared[0] }] : [];
        });
      }
      case 'myGroups':
        parseInput(operation, input);
        return sender.groupIds.map(id => this.store.groupInfo(id));
      case 'send': {
        const args = parseInput(operation, input);
        return this.message(sender, operation, args, () => {
          const { groupId, target } = this.target(sender, args.to, args.groupId);
          return { groupId, targets: [target] };
        });
      }
      case 'broadcast': {
        const args = parseInput(operation, input);
        return this.message(sender, operation, args, () => {
          const groupId = args.groupId ?? (sender.groupIds.length === 1 ? sender.groupId : undefined);
          if (!groupId) throw new IntercomError('GROUP_REQUIRED', 'Choose a group for this broadcast');
          if (groupId === systemGroupId || !sender.groupIds.includes(groupId)) {
            throw new IntercomError('CROSS_GROUP', 'Broadcasts require membership in a business group');
          }
          const targets = this.store.sessions(groupId).flatMap(peer => {
            const connection = this.connections.get(peer.id);
            return connection && peer.id !== sender.id ? [{ id: peer.id, generation: connection.generation }] : [];
          });
          return { groupId, targets };
        });
      }
      case 'ask': return this.ask(sender, parseInput(operation, input), signal);
      case 'reply': return this.reply(sender, parseInput(operation, input));
      case 'pending':
        parseInput(operation, input);
        return this.store.pending(sender.id);
      case 'receipt': return this.receipt(connection, parseInput(operation, input));
    }
  }

  disconnect(connection: PeerConnection) {
    const { sessionId } = connection;
    if (!sessionId || this.connections.get(sessionId) !== connection) return;
    this.connections.delete(sessionId);
    this.store.atomic(() => {
      this.store.disconnect(connection.generation);
      this.store.markOffline(Date.now(), sessionId);
      const session = this.store.session(sessionId)!;
      this.store.event('session', { sessionId, groupId: session.groupId, state: 'offline' });
    });
    for (const ask of this.asks.values()) if (ask.senderId === sessionId || ask.targetId === sessionId) {
      ask.settle(undefined, new IntercomError('UNAVAILABLE', 'A participant disconnected before the reply'));
    }
    this.notify();
  }

  private presence(session: StoredSession): Session { return { ...session, online: this.online(session.id) }; }

  private join(connection: PeerConnection, identity: Parameters<'join'>): Session {
    if (identity.protocolVersion !== protocolVersion) {
      throw new IntercomError('PROTOCOL_MISMATCH', `Daemon requires protocol ${protocolVersion}`);
    }
    if (identity.adapterKind === 'service' && !this.authorizeService(identity.serviceToken)) {
      throw new IntercomError('SERVICE_UNAUTHORIZED', 'A system service requires a valid service credential');
    }
    const current = this.store.lookup(identity);
    if (connection.sessionId && connection.sessionId !== current?.id) {
      throw new IntercomError('SESSION_ALREADY_BOUND', 'Connection is bound to a different session');
    }
    if (current && this.online(current.id) && this.connections.get(current.id) !== connection) {
      throw new IntercomError('SESSION_IN_USE', 'Session already has a live Intercom connection');
    }
    const session = this.store.atomic(() => {
      const bound = this.store.bind(identity, current);
      this.store.event('session', { groupId: bound.groupId, sessionId: bound.id, state: 'online' });
      return bound;
    });
    connection.sessionId = session.id;
    this.connections.set(session.id, connection);
    this.notify();
    return this.presence(session);
  }

  private sharedGroups(sender: StoredSession, peer: StoredSession): string[] {
    return sender.groupIds.filter(id => peer.groupIds.includes(id));
  }

  private routeGroups(sender: StoredSession, peer: StoredSession): string[] {
    if (peer.adapterKind === 'service') return [systemGroupId];
    if (sender.adapterKind === 'service') {
      return this.store.contactedService(peer.id, sender.id) ? [systemGroupId] : [];
    }
    return this.sharedGroups(sender, peer);
  }

  private target(sender: StoredSession, selector: string, requestedGroup?: string) {
    const exact = this.store.session(selector);
    const peer = exact ?? this.targetByName(sender, selector, requestedGroup);
    if (!peer) throw new IntercomError('PEER_NOT_FOUND', 'Peer not found in the visible groups');
    if (peer.id === sender.id) throw new IntercomError('SELF_TARGET', 'Cannot target your own Intercom session');
    const groups = this.routeGroups(sender, peer);
    if (!groups.length || (requestedGroup !== undefined && !groups.includes(requestedGroup))) {
      throw new IntercomError('CROSS_GROUP', 'Peer is outside the requested or shared groups');
    }
    const groupId = requestedGroup ?? (groups.length === 1 ? groups[0] : undefined);
    if (!groupId) throw new IntercomError('GROUP_REQUIRED', 'Choose one of the shared groups', { groupIds: groups });
    const connection = this.connections.get(peer.id);
    if (!connection) throw new IntercomError('PEER_OFFLINE', 'Peer is offline');
    return { groupId, target: { id: peer.id, generation: connection.generation } };
  }

  private targetByName(sender: StoredSession, name: string, groupId?: string): StoredSession | undefined {
    const matches = this.store.sessions().filter(peer => {
      if (peer.id === sender.id || peer.name !== name) return false;
      if (sender.adapterKind === 'service' && peer.adapterKind !== 'service') return false;
      const groups = this.routeGroups(sender, peer);
      return groupId === undefined ? groups.length > 0 : groups.includes(groupId);
    });
    if (matches.length > 1) throw new IntercomError('AMBIGUOUS_PEER', 'Multiple sessions share that name. Use a session ID.');
    return matches[0];
  }

  private message(
    sender: StoredSession, kind: 'send' | 'broadcast', input: Parameters<'send'> | Parameters<'broadcast'>,
    route: () => { groupId: string; targets: Target[] },
  ): MessageRecord {
    let created = false;
    const result = this.store.atomic(() => this.store.once(sender.id, input.clientRequestId, { kind, ...input }, () => {
      created = true;
      const { groupId, targets } = route();
      return this.store.createMessage(sender, groupId, input.text, kind, null, targets);
    }));
    if (created) this.dispatch(result);
    return result;
  }

  private ask(sender: StoredSession, input: Parameters<'ask'>, signal: AbortSignal): Promise<AskResult> {
    if (signal.aborted) throw new IntercomError('CANCELLED', 'Intercom ask cancelled');
    const { groupId, target } = this.target(sender, input.to, input.groupId);
    const result = this.store.atomic(() => this.store.createMessage(sender, groupId, input.text, 'ask', null, [target]));
    const { message } = result;
    const deferred = Promise.withResolvers<AskResult>();
    const abort = () => settle(undefined, new IntercomError('CANCELLED', 'Intercom ask cancelled'));
    const timer = setTimeout(() => settle(undefined, new IntercomError('ASK_TIMEOUT', 'Peer did not reply before the ask deadline')), input.timeoutMs);
    const settle = (reply?: Message, error?: IntercomError) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.asks.delete(message.id);
      this.store.atomic(() => this.store.finishAsk(message.id, reply ? 'replied' : error?.code === 'ASK_TIMEOUT' ? 'timed_out' : 'cancelled'));
      this.notify();
      if (reply) deferred.resolve({ request: this.store.message(message.id)!, reply });
      else deferred.reject(error);
    };
    this.asks.set(message.id, { senderId: sender.id, targetId: target.id, groupId, settle });
    signal.addEventListener('abort', abort, { once: true });
    this.dispatch(result);
    return deferred.promise;
  }

  private reply(sender: StoredSession, input: Parameters<'reply'>): MessageRecord {
    let created = false;
    const waiting = this.asks.get(input.replyTo);
    const result = this.store.atomic(() => this.store.once(sender.id, input.clientRequestId, { kind: 'reply', ...input }, () => {
      const original = this.store.record(input.replyTo);
      if (original.message.kind !== 'ask' || !original.deliveries.some(delivery => delivery.toSessionId === sender.id)) {
        throw new IntercomError('INVALID_REPLY_TARGET', 'Only the recipient of an ask can reply');
      }
      if (this.store.db.prepare('SELECT 1 FROM messages WHERE reply_to = ?').get(input.replyTo)) {
        throw new IntercomError('ALREADY_REPLIED', 'The ask already has a reply');
      }
      const { groupId, target } = this.target(sender, original.message.fromSessionId, original.message.groupIdAtAccept);
      const record = this.store.createMessage(sender, groupId, input.text, waiting ? 'reply' : 'late_reply', input.replyTo, [target]);
      if (waiting) {
        this.store.finishAsk(input.replyTo, 'replied');
        for (const delivery of record.deliveries) {
          this.store.receipt(delivery.id, record.message.id, 'host_accepted', 'ask_response');
        }
      }
      created = true;
      return this.store.record(record.message.id);
    }));
    if (created && waiting) waiting.settle(result.message);
    else if (created) this.dispatch(result);
    return result;
  }

  private receipt(connection: PeerConnection, input: Parameters<'receipt'>) {
    const delivery = this.store.delivery(input.deliveryId);
    if (!delivery || delivery.toSessionId !== connection.sessionId || delivery.generation !== connection.generation) {
      throw new IntercomError('DELIVERY_NOT_FOUND', 'Delivery does not belong to this connection');
    }
    if (delivery.state === input.state) return delivery;
    if ((delivery.state === 'queued' && input.state !== 'adapter_received') ||
      (delivery.state !== 'queued' && delivery.state !== 'adapter_received')) {
      throw new IntercomError('INVALID_RECEIPT', 'Delivery cannot transition to the requested state');
    }
    const result = this.store.atomic(() => this.store.receipt(delivery.id, delivery.messageId, input.state, input.source, input.detail));
    if (input.state === 'rejected' || input.state === 'delivery_unknown') {
      this.asks.get(delivery.messageId)?.settle(undefined,
        new IntercomError(input.state === 'rejected' ? 'HOST_REJECTED' : 'DELIVERY_UNKNOWN', input.detail ?? 'Did not obtain host acceptance'));
    }
    this.notify();
    return result;
  }

  private dispatch(record: MessageRecord) {
    for (const delivery of record.deliveries) {
      const connection = this.connections.get(delivery.toSessionId);
      try {
        if (!connection) throw new Error('Session disconnected');
        connection.deliver({ message: record.message, delivery });
      } catch {
        this.store.atomic(() => this.store.receipt(delivery.id, record.message.id, 'delivery_unknown', 'daemon', 'Could not write to the adapter'));
        this.asks.get(record.message.id)?.settle(undefined, new IntercomError('DELIVERY_UNKNOWN', 'Could not write to the adapter'));
      }
    }
    this.notify();
  }
}

export function peerConnection(deliver: PeerConnection['deliver']): PeerConnection {
  return { generation: randomUUID(), deliver };
}
