import { z } from 'zod';

export const protocolVersion = 1;
export const defaultGroupId = 'default';
export const systemGroupId = 'system';
export const maxFrameBytes = 1024 * 1024;

const id = z.string().trim().min(1).max(256);
const label = z.string().trim().min(1).max(100);
const text = z.string().min(1).max(64 * 1024).refine(value => value.trim().length > 0);
export const identitySchema = z.object({
  adapterKind: z.enum(['omp', 'agy', 'alma', 'codex', 'service']),
  hostInstanceId: id,
  nativeSessionId: id,
  name: label.optional(),
  cwd: z.string().max(4096).optional(),
});
export type NativeIdentity = z.infer<typeof identitySchema>;

export interface Session {
  id: string;
  adapterKind: NativeIdentity['adapterKind'];
  nativeSessionId: string;
  name: string;
  cwd: string | null;
  groupId: string;
  groupIds: string[];
  membershipVersion: number;
  online: boolean;
}

export interface Group {
  id: string;
  name: string;
  version: number;
  members: Session[];
}

export interface MoveResult {
  group: Group;
  sessions: Session[];
}

export type DeliveryState = 'queued' | 'adapter_received' | 'host_accepted' | 'rejected' | 'delivery_unknown' | 'expired';
export type AskState = 'waiting' | 'replied' | 'timed_out' | 'cancelled';
export interface Message {
  id: string;
  groupIdAtAccept: string;
  fromSessionId: string;
  fromName: string;
  text: string;
  kind: 'send' | 'broadcast' | 'ask' | 'reply' | 'late_reply';
  replyTo: string | null;
  createdAt: number;
  askState: AskState | null;
}

export interface Delivery {
  id: string;
  toSessionId: string;
  state: DeliveryState;
  source: string;
  detail: string | null;
}

export interface MessageRecord {
  message: Message;
  deliveries: Delivery[];
}

export interface IncomingDelivery {
  message: Message;
  delivery: Delivery;
}

export interface IntercomEvent {
  cursor: number;
  type: 'session' | 'group' | 'message' | 'delivery' | 'ask';
  timestamp: number;
  sessionId?: string;
  groupId?: string;
  messageId?: string;
  deliveryId?: string;
  state?: string;
  source?: string;
  detail?: string;
}

export interface EventsPage {
  events: IntercomEvent[];
  cursor: number;
  reset: boolean;
}

const membership = {
  sessionIds: z.array(id).max(100).refine(ids => new Set(ids).size === ids.length),
  expectedMembershipVersions: z.record(id, z.number().int().positive()).optional(),
  operationId: id.optional(),
};
const none = z.object({});
const page = { after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() };
const groupChange = z.object({ groupId: id, ...membership, sessionIds: membership.sessionIds.min(1) });

export const operations = {
  status: none,
  listSessions: z.object({ groupId: id.optional(), online: z.boolean().optional() }),
  listGroups: none,
  createGroup: z.object({ name: label, ...membership }),
  moveGroup: groupChange,
  addGroupMembers: groupChange,
  removeGroupMembers: groupChange,
  listMessages: z.object({ groupId: id.optional(), before: z.number().int().positive().optional(), limit: page.limit }),
  getMessage: z.object({ messageId: id }),
  readEvents: z.object(page),
  join: identitySchema.extend({ protocolVersion: z.number().int(), serviceToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  sessionStatus: none,
  rename: z.object({ name: label }),
  listPeers: none,
  myGroups: none,
  send: z.object({ to: id, text, groupId: id.optional(), clientRequestId: id.optional() }),
  broadcast: z.object({ text, groupId: id.optional(), clientRequestId: id.optional() }),
  ask: z.object({ to: id, text, groupId: id.optional(), timeoutMs: z.number().int().min(1).max(600000).default(300000) }),
  reply: z.object({ replyTo: id, text, clientRequestId: id.optional() }),
  pending: none,
  receipt: z.object({
    deliveryId: id,
    state: z.enum(['adapter_received', 'host_accepted', 'rejected', 'delivery_unknown']),
    source: id,
    detail: z.string().max(1024).optional(),
  }),
} as const;

export interface Results {
  status: { protocolVersion: number; onlineSessions: number; capabilities: string[]; dashboardUrl?: string };
  listSessions: Session[];
  listGroups: Group[];
  createGroup: MoveResult;
  moveGroup: MoveResult;
  addGroupMembers: MoveResult;
  removeGroupMembers: MoveResult;
  listMessages: { records: MessageRecord[]; nextBefore: number | null };
  getMessage: MessageRecord;
  readEvents: EventsPage;
  join: Session;
  sessionStatus: Session;
  rename: Session;
  listPeers: Session[];
  myGroups: Array<Omit<Group, 'members'>>;
  send: MessageRecord;
  broadcast: MessageRecord;
  ask: { request: Message; reply: Message };
  reply: MessageRecord;
  pending: Message[];
  receipt: Delivery;
}

export const controlOperations = [
  'status', 'listSessions', 'listGroups', 'createGroup', 'moveGroup', 'addGroupMembers', 'removeGroupMembers',
  'listMessages', 'getMessage', 'readEvents',
] as const;
export type ControlOperation = (typeof controlOperations)[number];
export type Operation = keyof typeof operations;
export type Input<K extends Operation> = z.input<(typeof operations)[K]>;
export type Parameters<K extends Operation> = z.output<(typeof operations)[K]>;
export type ReceiptInput = Input<'receipt'>;

export class IntercomError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'IntercomError';
  }
}

export function parseInput<K extends Operation>(operation: K, value: unknown): Parameters<K> {
  const result = operations[operation].safeParse(value);
  if (!result.success) {
    throw new IntercomError('INVALID_REQUEST', result.error.issues.map(issue =>
      `${issue.path.join('.') || operation}: ${issue.message}`).join(', '));
  }
  return result.data as Parameters<K>;
}

export function errorPayload(error: unknown) {
  return error instanceof IntercomError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'INTERNAL_ERROR', message: 'Intercom could not complete the operation' };
}

export function formatIncoming({ message }: IncomingDelivery): string {
  const fromName = message.fromName.replace(/[\r\n]+/g, ' ');
  if (message.kind === 'late_reply') {
    return `[Intercom late reply] From ${fromName}\nMessage ID: ${message.id}\nIn reply to ask: ${message.replyTo}\n\n${message.text}`;
  }
  const reply = message.kind === 'ask' ? `\nReply with the Intercom reply tool using message ID ${message.id}.` : '';
  return `[Intercom peer message] From ${fromName}\nMessage ID: ${message.id}${reply}\n\n${message.text}`;
}
