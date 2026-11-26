import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  defaultGroupId, IntercomError,
  type Delivery, type EventsPage, type Group, type IntercomEvent, type Message,
  type MessageRecord, type MoveResult, type NativeIdentity, type Parameters, type Session,
} from '../../packages/protocol/index.js';

const sessionColumns = `id, adapter_kind AS adapterKind, native_id AS nativeSessionId, name, cwd,
  group_id AS groupId, membership_version AS membershipVersion`;
const messageColumns = `id, group_id AS groupIdAtAccept, from_id AS fromSessionId, from_name AS fromName, text, kind,
  reply_to AS replyTo, created_at AS createdAt, ask_state AS askState`;
const deliveryColumns = `id, to_id AS toSessionId, state, source, detail`;
type StoredSession = Omit<Session, 'online'>;
export type StoredDelivery = Delivery & { messageId: string; generation: string };

type Online = (id: string) => boolean;
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
    const schema = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (schema === 0) this.atomic(() => this.db.exec(`
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, version INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, adapter_kind TEXT NOT NULL, host_id TEXT NOT NULL, native_id TEXT NOT NULL,
        name TEXT NOT NULL, cwd TEXT, group_id TEXT NOT NULL REFERENCES groups(id), membership_version INTEGER NOT NULL,
        UNIQUE(adapter_kind, host_id, native_id));
      CREATE INDEX sessions_group ON sessions(group_id, name);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL,
        from_id TEXT NOT NULL REFERENCES sessions(id), from_name TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
        reply_to TEXT REFERENCES messages(id), created_at INTEGER NOT NULL, ask_state TEXT);
      CREATE INDEX messages_group_seq ON messages(group_id, seq);
      CREATE INDEX messages_reply ON messages(reply_to);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
        to_id TEXT NOT NULL REFERENCES sessions(id), generation TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL, detail TEXT);
      CREATE INDEX deliveries_message ON deliveries(message_id);
      CREATE INDEX deliveries_target_state ON deliveries(to_id, state);
      CREATE TABLE operations (scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(scope, id));
      CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);
      INSERT INTO groups VALUES ('default', 'default', 1);
      PRAGMA user_version = 1;
    `));
    else if (schema !== 1) throw new Error(`Unsupported Intercom database schema ${schema}`);
  }

  atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  event(type: IntercomEvent['type'], payload: Omit<IntercomEvent, 'cursor' | 'type' | 'timestamp'>) {
    this.db.prepare('INSERT INTO events(type, timestamp, payload) VALUES (?, ?, ?)').run(type, Date.now(), JSON.stringify(payload));
  }

  events({ after, limit = 100 }: Parameters<'readEvents'>): EventsPage {
    const latest = Number(this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS latest FROM events').get()?.latest);
    if (after === undefined) return { events: [], cursor: latest, reset: true };
    if (after > latest) return { events: [], cursor: latest, reset: true };
    const events = this.db.prepare('SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?').all(after, limit)
      .map(row => ({ ...JSON.parse(String(row.payload)), cursor: Number(row.cursor), type: row.type, timestamp: Number(row.timestamp) }) as IntercomEvent);
    return { events, cursor: events.at(-1)?.cursor ?? after, reset: false };
  }

  lookup(identity: NativeIdentity): StoredSession | undefined {
    return this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE adapter_kind = ? AND host_id = ? AND native_id = ?`)
      .get(identity.adapterKind, identity.hostInstanceId, identity.nativeSessionId) as StoredSession | undefined;
  }

  bind(identity: NativeIdentity, current?: StoredSession): StoredSession {
    const { adapterKind, hostInstanceId, nativeSessionId, cwd, name } = identity;
    const id = current?.id ?? randomUUID();
    const generatedName = `${adapterKind}-${id.slice(-12)}`;
    if (current) {
      const legacyName = `${adapterKind}-${nativeSessionId.slice(0, 8)}`;
      const existingName = current.name === legacyName ? generatedName : current.name;
      this.db.prepare('UPDATE sessions SET name = ?, cwd = ? WHERE id = ?')
        .run(name ?? existingName, cwd ?? current.cwd, id);
      return this.session(current.id)!;
    }
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, adapterKind, hostInstanceId, nativeSessionId, name ?? generatedName, cwd ?? null, defaultGroupId);
    this.db.prepare('UPDATE groups SET version = version + 1 WHERE id = ?').run(defaultGroupId);
    return this.session(id)!;
  }

  session(id: string): StoredSession | undefined {
    return this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`).get(id) as StoredSession | undefined;
  }

  sessions(groupId?: string): StoredSession[] {
    return (groupId === undefined
      ? this.db.prepare(`SELECT ${sessionColumns} FROM sessions ORDER BY name, id`).all()
      : this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE group_id = ? ORDER BY name, id`).all(groupId)) as StoredSession[];
  }

  group(id: string, online: Online): Group {
    const row = this.db.prepare('SELECT id, name, version FROM groups WHERE id = ?').get(id) as Omit<Group, 'members'> | undefined;
    if (!row) throw new IntercomError('GROUP_NOT_FOUND', 'Group not found');
    return { ...row, members: this.sessions(id).map(session => ({ ...session, online: online(session.id) })) };
  }

  groups(online: Online): Group[] {
    return this.db.prepare('SELECT id FROM groups ORDER BY name, id').all().map(row => this.group(String(row.id), online));
  }

  changeGroup(input: Parameters<'createGroup'> | Parameters<'moveGroup'>, online: Online, check: (id: string) => void): MoveResult {
    const create = 'name' in input;
    return this.atomic(() => this.once('group', input.operationId, input, () => {
      let groupId: string;
      if (create) {
        if (this.db.prepare('SELECT 1 FROM groups WHERE name = ?').get(input.name)) {
          throw new IntercomError('DUPLICATE_GROUP_NAME', `Group already exists: ${input.name}`);
        }
        groupId = randomUUID();
        this.db.prepare('INSERT INTO groups VALUES (?, ?, 1)').run(groupId, input.name);
      } else {
        groupId = input.groupId;
        this.group(groupId, online);
      }
      const byId = input.sessionIds.map(id => {
        const session = this.session(id);
        if (!session) throw new IntercomError('SESSION_NOT_FOUND', 'Session not found', { sessionId: id });
        const expected = input.expectedMembershipVersions?.[id];
        if (expected !== undefined && expected !== session.membershipVersion) {
          throw new IntercomError('MEMBERSHIP_VERSION_CONFLICT', 'Session membership changed', { sessionId: id });
        }
        if (session.groupId !== groupId) check(id);
        return session;
      });
      const groupsChanged = new Set<string>();
      for (const session of byId) {
        if (session.groupId === groupId) continue;
        groupsChanged.add(session.groupId);
        groupsChanged.add(groupId);
        this.db.prepare('UPDATE sessions SET group_id = ?, membership_version = membership_version + 1 WHERE id = ?')
          .run(groupId, session.id);
        this.event('session', { sessionId: session.id, groupId, state: 'moved' });
        const queued = this.db.prepare(`SELECT d.id, d.message_id AS messageId FROM deliveries d JOIN messages m ON m.id = d.message_id
          WHERE d.state = 'queued' AND (d.to_id = ? OR m.from_id = ?)`).all(session.id, session.id);
        for (const row of queued) this.receipt(String(row.id), String(row.messageId), 'expired', 'daemon', 'Group membership changed');
      }
      for (const id of groupsChanged) this.db.prepare('UPDATE groups SET version = version + 1 WHERE id = ?').run(id);
      if (create || groupsChanged.size) this.event('group', { groupId, state: create ? 'created' : 'updated' });
      return { group: this.group(groupId, online), sessions: byId.map(s => ({ ...this.session(s.id)!, online: online(s.id) })) };
    }));
  }

  once<T>(scope: string, id: string | undefined, input: unknown, work: () => T): T {
    if (!id) return work();
    // Sort object keys without changing array order so field ordering cannot defeat idempotency.
    const fingerprint = JSON.stringify(input, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    const existing = this.db.prepare('SELECT fingerprint, result FROM operations WHERE scope = ? AND id = ?').get(scope, id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IntercomError('OPERATION_CONFLICT', 'Operation ID already used with different input');
      return JSON.parse(String(existing.result)) as T;
    }
    const result = work();
    this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(scope, id, fingerprint, JSON.stringify(result));
    return result;
  }

  message(id: string): Message | undefined {
    return this.db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(id) as Message | undefined;
  }

  record(id: string): MessageRecord {
    const message = this.message(id);
    if (!message) throw new IntercomError('MESSAGE_NOT_FOUND', 'Message not found');
    const deliveries = this.db.prepare(`SELECT ${deliveryColumns} FROM deliveries WHERE message_id = ?`).all(id) as unknown as Delivery[];
    return { message, deliveries };
  }

  listMessages({ groupId, before = Number.MAX_SAFE_INTEGER, limit = 50 }: Parameters<'listMessages'>) {
    const rows = groupId === undefined
      ? this.db.prepare('SELECT id, seq FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(before, limit + 1)
      : this.db.prepare('SELECT id, seq FROM messages WHERE group_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(groupId, before, limit + 1);
    const page = rows.slice(0, limit);
    return { records: page.map(row => this.record(String(row.id))), nextBefore: rows.length > limit ? Number(page.at(-1)?.seq) : null };
  }

  createMessage(from: StoredSession, text: string, kind: Message['kind'], replyTo: string | null, targets: { id: string; generation: string }[]): MessageRecord {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO messages(id, group_id, from_id, from_name, text, kind, reply_to, created_at, ask_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, from.groupId, from.id, from.name, text, kind, replyTo, Date.now(), kind === 'ask' ? 'waiting' : null);
    this.event('message', { messageId: id, groupId: from.groupId, sessionId: from.id, state: kind });
    const insert = this.db.prepare(`INSERT INTO deliveries VALUES (?, ?, ?, ?, 'queued', 'daemon', NULL)`);
    for (const target of targets) {
      const deliveryId = randomUUID();
      insert.run(deliveryId, id, target.id, target.generation);
      this.event('delivery', { messageId: id, deliveryId, sessionId: target.id, state: 'queued', source: 'daemon' });
    }
    return this.record(id);
  }

  delivery(id: string): StoredDelivery | undefined {
    return this.db.prepare(`SELECT ${deliveryColumns}, message_id AS messageId, generation FROM deliveries WHERE id = ?`).get(id) as StoredDelivery | undefined;
  }

  receipt(id: string, messageId: string, state: Delivery['state'], source: string, detail?: string): Delivery {
    this.db.prepare('UPDATE deliveries SET state = ?, source = ?, detail = ? WHERE id = ?').run(state, source, detail ?? null, id);
    this.event('delivery', { messageId, deliveryId: id, state, source, detail });
    return this.delivery(id)!;
  }

  finishAsk(messageId: string, state: Exclude<Message['askState'], 'waiting' | null>) {
    if (this.db.prepare("UPDATE messages SET ask_state = ? WHERE id = ? AND ask_state = 'waiting'").run(state, messageId).changes) {
      this.event('ask', { messageId, state });
    }
  }

  pending(sessionId: string) {
    return this.db.prepare(`SELECT m.id FROM messages m JOIN deliveries d ON d.message_id = m.id
      WHERE d.to_id = ? AND m.kind = 'ask' AND m.ask_state = 'waiting' ORDER BY m.seq`).all(sessionId)
      .map(row => this.message(String(row.id))!);
  }

  disconnect(generation?: string) {
    const rows = generation === undefined
      ? this.db.prepare("SELECT id, message_id AS messageId FROM deliveries WHERE state IN ('queued', 'adapter_received')").all()
      : this.db.prepare("SELECT id, message_id AS messageId FROM deliveries WHERE state IN ('queued', 'adapter_received') AND generation = ?").all(generation);
    for (const row of rows) this.receipt(String(row.id), String(row.messageId), 'delivery_unknown', 'daemon', 'Connection ended before host acknowledgement');
    if (generation === undefined) for (const row of this.db.prepare("SELECT id FROM messages WHERE ask_state = 'waiting'").all()) {
      this.finishAsk(String(row.id), 'cancelled');
    }
  }
}
