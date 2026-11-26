import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join as pathJoin, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  createHttpSdk, createSessionSdk, IntercomError, maxFrameBytes,
  type ControlSdk, type IncomingDelivery, type NativeIdentity, type OnDelivery,
  type Operation, type Results, type SessionSdk, type Transport,
} from './index.js';

const endpointSchema = z.object({ origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), token: z.string().regex(/^[a-f0-9]{64}$/) });
const responseId = z.string();
const localResponse = z.union([
  z.object({ type: z.literal('response'), id: responseId, error: z.object({ code: z.string(), message: z.string(), details: z.unknown() }) }),
  z.object({ type: z.literal('response'), id: responseId, result: z.unknown() }),
]);
const localDelivery = z.object({
  type: z.literal('delivery'),
  data: z.object({
    message: z.object({
      id: z.string(), groupIdAtAccept: z.string(), fromSessionId: z.string(), fromName: z.string(), text: z.string(),
      kind: z.enum(['send', 'broadcast', 'ask', 'reply', 'late_reply']), replyTo: z.string().nullable(), createdAt: z.number(),
      askState: z.enum(['waiting', 'replied', 'timed_out', 'cancelled']).nullable(),
    }),
    delivery: z.object({
      id: z.string(), toSessionId: z.string(), source: z.string(), detail: z.string().nullable(),
      state: z.enum(['queued', 'adapter_received', 'host_accepted', 'rejected', 'delivery_unknown', 'expired']),
    }),
  }),
});

export interface LocalTransport extends Transport {
  close(): void;
  readonly closed: Promise<void>;
}

export function runtimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INTERCOM_RUNTIME_DIR || pathJoin(homedir(), '.agent-intercom/v2'));
}

export function createLocalControlSdk(directory = runtimeDirectory()): ControlSdk {
  try {
    const endpoint = endpointSchema.parse(JSON.parse(readFileSync(pathJoin(directory, 'endpoint.json'), 'utf8')));
    return createHttpSdk(endpoint.origin, {
      token: endpoint.token,
      async fetch(input, init) {
        try { return await globalThis.fetch(input, init); }
        catch (error) {
          if (init?.signal?.aborted) throw error;
          throw new IntercomError('UNAVAILABLE', `Intercom daemon endpoint unavailable in ${directory}`);
        }
      },
    });
  } catch {
    throw new IntercomError('UNAVAILABLE', `Intercom daemon endpoint unavailable in ${directory}`);
  }
}

export async function connectLocal(path: string, onDelivery?: OnDelivery): Promise<LocalTransport> {
  const socket = createConnection(path);
  socket.setEncoding('utf8');
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const callbacks = new Map<string, { handle(frame: z.output<typeof localResponse>): void; fail(error: Error): void }>();
  const unavailable = () => new IntercomError('UNAVAILABLE', 'Intercom local connection closed');
  socket.once('connect', ready.resolve);
  socket.on('error', () => ready.reject(unavailable()));
  socket.once('close', () => {
    ready.reject(unavailable());
    for (const callback of callbacks.values()) callback.fail(unavailable());
    callbacks.clear();
    closed.resolve();
  });
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, boundary)) > maxFrameBytes) { socket.destroy(); return; }
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      try {
        const frame: unknown = JSON.parse(line);
        if (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'delivery') {
          onDelivery?.(localDelivery.parse(frame).data);
        } else {
          const response = localResponse.parse(frame);
          callbacks.get(response.id)?.handle(response);
        }
      } catch { socket.destroy(); return; }
    }
    if (Buffer.byteLength(buffer) > maxFrameBytes) socket.destroy();
  });
  await ready.promise;
  return {
    closed: closed.promise,
    close: () => socket.destroy(),
    request<K extends Operation>(operation: K, input: unknown, signal?: AbortSignal): Promise<Results[K]> {
      if (socket.destroyed) return Promise.reject(unavailable());
      if (signal?.aborted) return Promise.reject(new IntercomError('CANCELLED', 'Intercom request cancelled'));
      const id = randomUUID();
      const deferred = Promise.withResolvers<Results[K]>();
      const frame = JSON.stringify({ type: 'request', id, operation, input });
      if (Buffer.byteLength(frame) > maxFrameBytes) return Promise.reject(new IntercomError('INVALID_REQUEST', 'Intercom request exceeds frame limit'));
      function cleanup() {
        callbacks.delete(id);
        signal?.removeEventListener('abort', abort);
      }
      function abort() {
        cleanup();
        if (!socket.destroyed) socket.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
        deferred.reject(new IntercomError('CANCELLED', 'Intercom request cancelled'));
      }
      callbacks.set(id, {
        handle(response) {
          cleanup();
          if ('error' in response) {
            deferred.reject(new IntercomError(response.error.code, response.error.message, response.error.details));
          } else {
            // The response ID matches the pending request for this operation on the local daemon.
            deferred.resolve(response.result as Results[K]);
          }
        },
        fail(error) { cleanup(); deferred.reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      socket.write(`${frame}\n`);
      return deferred.promise;
    },
  };
}

export interface LocalSession { sdk: SessionSdk; close(): void }
export async function openLocalSession(
  identity: NativeIdentity,
  onDelivery: (event: IncomingDelivery, sdk: SessionSdk) => Promise<void>,
  options: { directory?: string; signal?: AbortSignal } = {},
): Promise<LocalSession> {
  const path = pathJoin(options.directory ?? runtimeDirectory(), 'daemon.sock');
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let active: LocalTransport | undefined;
  let inbound = Promise.resolve();
  function close() { stop.abort(); active?.close(); }
  signal.addEventListener('abort', close, { once: true });
  const sdk = createSessionSdk({
    request(operation, input, requestSignal) {
      if (!active) return Promise.reject(new IntercomError('UNAVAILABLE', 'Intercom session is reconnecting'));
      return active.request(operation, input, requestSignal);
    },
  });
  async function connect() {
    const connection = await connectLocal(path, event => {
      inbound = inbound.then(async () => {
        if (signal.aborted || active !== connection) return;
        const boundSdk = createSessionSdk(connection);
        try {
          await boundSdk.receipt({ deliveryId: event.delivery.id, state: 'adapter_received', source: identity.adapterKind });
        } catch { return; }
        try { await onDelivery(event, boundSdk); } catch {
          await boundSdk.receipt({ deliveryId: event.delivery.id, state: 'delivery_unknown', source: identity.adapterKind }).catch(() => {});
        }
      });
    });
    try {
      if (signal.aborted) throw new IntercomError('CANCELLED', 'Intercom session closed');
      await createSessionSdk(connection).join(identity);
      if (signal.aborted) throw new IntercomError('CANCELLED', 'Intercom session closed');
      active = connection;
      return connection;
    } catch (error) { connection.close(); throw error; }
  }
  let first: LocalTransport;
  try { first = await connect(); } catch (error) { close(); throw error; }
  void (async () => {
    let connection = first;
    while (!signal.aborted) {
      await connection.closed;
      active = undefined;
      while (!signal.aborted) {
        try {
          await delay(500, undefined, { signal });
          connection = await connect();
          break;
        } catch { if (signal.aborted) return; }
      }
    }
  })();
  return { sdk, close };
}
