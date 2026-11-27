import {
  IntercomError, parseInput, protocolVersion,
  type ControlOperation, type EventsPage, type IncomingDelivery, type Input, type NativeIdentity,
  type Operation, type Results,
} from '../protocol/index.js';
export * from '../protocol/index.js';

export interface Transport {
  request<K extends Operation>(operation: K, input: unknown, signal?: AbortSignal): Promise<Results[K]>;
  events?(after: number | undefined, signal: AbortSignal): AsyncIterable<EventsPage>;
}

export interface ControlSdk {
  status(): Promise<Results['status']>;
  listSessions(input?: Input<'listSessions'>): Promise<Results['listSessions']>;
  listGroups(): Promise<Results['listGroups']>;
  createGroup(input: Input<'createGroup'>): Promise<Results['createGroup']>;
  moveGroup(input: Input<'moveGroup'>): Promise<Results['moveGroup']>;
  addGroupMembers(input: Input<'addGroupMembers'>): Promise<Results['addGroupMembers']>;
  removeGroupMembers(input: Input<'removeGroupMembers'>): Promise<Results['removeGroupMembers']>;
  listMessages(input?: Input<'listMessages'>): Promise<Results['listMessages']>;
  getMessage(input: Input<'getMessage'>, signal?: AbortSignal): Promise<Results['getMessage']>;
  readEvents(input?: Input<'readEvents'>): Promise<EventsPage>;
  events(after: number | undefined, signal: AbortSignal): AsyncIterable<EventsPage>;
}

export function createSdk(transport: Transport): ControlSdk {
  const call = <K extends ControlOperation>(op: K, input: Input<K>, signal?: AbortSignal) =>
    transport.request(op, parseInput(op, input), signal);
  return {
    status: () => call('status', {}),
    listSessions: (input: Input<'listSessions'> = {}) => call('listSessions', input),
    listGroups: () => call('listGroups', {}),
    createGroup: (input: Input<'createGroup'>) => call('createGroup', input),
    moveGroup: (input: Input<'moveGroup'>) => call('moveGroup', input),
    addGroupMembers: input => call('addGroupMembers', input),
    removeGroupMembers: input => call('removeGroupMembers', input),
    listMessages: (input: Input<'listMessages'> = {}) => call('listMessages', input),
    getMessage: (input, signal) => call('getMessage', input, signal),
    readEvents: (input: Input<'readEvents'> = {}) => call('readEvents', input),
    events: (after: number | undefined, signal: AbortSignal) => {
      if (!transport.events) throw new IntercomError('UNSUPPORTED', 'This transport cannot subscribe to events');
      return transport.events(after, signal);
    },
  };
}

export interface SessionSdk {
  join(identity: NativeIdentity, serviceToken?: string, signal?: AbortSignal): Promise<Results['join']>;
  sessionStatus(): Promise<Results['sessionStatus']>;
  rename(input: Input<'rename'>): Promise<Results['rename']>;
  listPeers(signal?: AbortSignal): Promise<Results['listPeers']>;
  myGroups(): Promise<Results['myGroups']>;
  send(input: Input<'send'>, signal?: AbortSignal): Promise<Results['send']>;
  broadcast(input: Input<'broadcast'>): Promise<Results['broadcast']>;
  ask(input: Input<'ask'>, signal?: AbortSignal): Promise<Results['ask']>;
  reply(input: Input<'reply'>, signal?: AbortSignal): Promise<Results['reply']>;
  pending(): Promise<Results['pending']>;
  receipt(input: Input<'receipt'>, signal?: AbortSignal): Promise<Results['receipt']>;
}

export function createSessionSdk(transport: Transport): SessionSdk {
  const call = <K extends Exclude<Operation, ControlOperation>>(op: K, input: Input<K>, signal?: AbortSignal) =>
    transport.request(op, parseInput(op, input), signal);
  return {
    join: (identity, serviceToken, signal) => call('join', { ...identity, protocolVersion, serviceToken }, signal),
    sessionStatus: () => call('sessionStatus', {}),
    rename: (input: Input<'rename'>) => call('rename', input),
    listPeers: signal => call('listPeers', {}, signal),
    myGroups: () => call('myGroups', {}),
    send: (input, signal) => call('send', input, signal),
    broadcast: (input: Input<'broadcast'>) => call('broadcast', input),
    ask: (input: Input<'ask'>, signal?: AbortSignal) => call('ask', input, signal),
    reply: (input, signal) => call('reply', input, signal),
    pending: () => call('pending', {}),
    receipt: (input, signal) => call('receipt', input, signal),
  };
}
export type OnDelivery = (event: IncomingDelivery) => void;

const paths: Record<Exclude<ControlOperation, 'moveGroup' | 'addGroupMembers' | 'removeGroupMembers' | 'getMessage'>, [string, string]> = {
  status: ['GET', '/status'],
  listSessions: ['GET', '/sessions'],
  listGroups: ['GET', '/groups'],
  createGroup: ['POST', '/groups'],
  listMessages: ['GET', '/messages'],
  readEvents: ['GET', '/events'],
};

export function controlRoute(operation: ControlOperation, input: Record<string, unknown>): [string, string] {
  if (operation === 'moveGroup') return ['POST', `/groups/${encodeURIComponent(String(input.groupId))}/members:move`];
  if (operation === 'addGroupMembers') return ['POST', `/groups/${encodeURIComponent(String(input.groupId))}/members:add`];
  if (operation === 'removeGroupMembers') return ['POST', `/groups/${encodeURIComponent(String(input.groupId))}/members:remove`];
  if (operation === 'getMessage') return ['GET', `/messages/${encodeURIComponent(String(input.messageId))}`];
  return paths[operation];
}

export function createHttpSdk(origin = '', options: { token?: string; fetch?: typeof fetch } = {}): ControlSdk {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = `${origin.replace(/\/$/, '')}/api/v1`;
  const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};
  async function checked(response: Response) {
    if (response.ok) return response;
    const payload = await response.json().catch(() => null);
    throw new IntercomError(payload?.error?.code ?? 'HTTP_ERROR',
      payload?.error?.message ?? `Intercom API returned HTTP ${response.status}`, payload?.error?.details);
  }
  return createSdk({
    async request<K extends Operation>(operation: K, raw: unknown, signal?: AbortSignal): Promise<Results[K]> {
      const input = raw as Record<string, unknown>;
      const [method, route] = controlRoute(operation as ControlOperation, input);
      const query = new URLSearchParams();
      if (method === 'GET' && operation !== 'getMessage') {
        for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
      }
      const suffix = query.size ? `?${query}` : '';
      const response = await checked(await fetcher(`${base}${route}${suffix}`, {
        method,
        headers: { ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
        signal,
      }));
      return response.json() as Promise<Results[K]>;
    },
    async *events(after, signal) {
      let cursor = after;
      while (!signal.aborted) {
        try {
          const query = cursor === undefined ? '' : `?after=${cursor}`;
          const response = await checked(await fetcher(`${base}/events${query}`, {
            headers: { ...headers, Accept: 'text/event-stream' }, signal,
          }));
          if (!response.body) throw new IntercomError('INVALID_RESPONSE', 'Missing event stream body');
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += chunk.value;
              let boundary: number;
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const record = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
                if (!data.length) continue;
                const page = JSON.parse(data.join('\n')) as EventsPage;
                cursor = page.cursor;
                yield page;
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof IntercomError && !['HTTP_ERROR', 'UNAVAILABLE'].includes(error.code)) throw error;
        }
        if (!signal.aborted) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
          function abort() { clearTimeout(timer); resolve(); }
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    },
  });
}
