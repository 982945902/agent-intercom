import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  controlOperations, errorPayload, IntercomError, maxFrameBytes, operations,
  type ControlOperation, type Operation,
} from '../../packages/protocol/index.js';
import { runtimeDirectory } from '../../packages/sdk/node.js';
import { Daemon, peerConnection } from './daemon.js';
import { Store } from './store.js';

const frameId = z.string().min(1).max(256);
const localFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: frameId, operation: z.enum(operationsKeys()), input: z.unknown() }),
  z.object({ type: z.literal('cancel'), id: frameId }),
]);
function operationsKeys() { return Object.keys(operations) as Operation[]; }
function isControl(operation: Operation): operation is ControlOperation {
  return controlOperations.some(control => control === operation);
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new IntercomError('INVALID_REQUEST', 'Expected application/json');
  }
  let received = 0;
  const chunks: Buffer[] = [];
  // Keep the socket alive on a rejected body so the client can read the error.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes: Buffer = chunk;
    received += bytes.length;
    if (received > maxFrameBytes) {
      request.resume();
      throw new IntercomError('INVALID_REQUEST', 'Request body exceeds size limit');
    }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks, received).toString('utf8')); }
  catch { throw new IntercomError('INVALID_REQUEST', 'Invalid JSON body'); }
}

function queryInteger(search: URLSearchParams, key: string): number | undefined {
  const value = search.get(key);
  return value === null ? undefined : /^\d+$/.test(value) ? Number(value) : NaN;
}
function httpStatus(error: unknown) {
  if (!(error instanceof IntercomError)) return 500;
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (['OPERATION_CONFLICT', 'DUPLICATE_GROUP_NAME', 'MEMBERSHIP_VERSION_CONFLICT', 'ACTIVE_ASK'].includes(error.code)) return 409;
  return 400;
}

async function main() {
  const directory = runtimeDirectory();
  mkdirSync(directory, { mode: 0o700, recursive: true });
  process.umask(0o077);
  const lock = new DatabaseSync(join(directory, 'daemon-lock.sqlite'));
  try { lock.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    lock.close();
    if (error instanceof Error && 'errcode' in error && error.errcode === 5) {
      throw new IntercomError('ALREADY_RUNNING', 'Intercom daemon is already running in this directory');
    }
    throw error;
  }
  const socketPath = join(directory, 'daemon.sock');
  const endpointPath = join(directory, 'endpoint.json');
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const dashboard = fileURLToPath(new URL('../../dashboard/', import.meta.url));
  const clients = new Set<{ flush(): void; close(): void }>();
  const store = new Store(join(directory, 'intercom.sqlite'));
  const daemon = new Daemon(store, () => { for (const client of clients) client.flush(); });
  const offlineRetention = 24 * 60 * 60 * 1000;
  const sweepOffline = () => daemon.archiveOffline(Date.now() - offlineRetention);
  sweepOffline();
  let origin = '';
  let closing = false;
  const shutdownPeers = new Set<() => void>();

  const ipc = createSocketServer(socket => {
    if (closing) { socket.destroy(); return; }
    socket.setEncoding('utf8');
    const pending = new Map<string, AbortController>();
    function write(frame: unknown) {
      if (socket.destroyed) throw new Error('Adapter socket closed');
      const payload = JSON.stringify(frame);
      if (Buffer.byteLength(payload) > maxFrameBytes || socket.writableLength + Buffer.byteLength(payload) > 4 * maxFrameBytes) {
        socket.destroy();
        throw new Error('Adapter socket exceeded frame or buffer limit');
      }
      socket.write(`${payload}\n`);
    }
    const connection = peerConnection(data => write({ type: 'delivery', data }));
    const respond = (frame: unknown) => { try { write(frame); } catch { socket.destroy(); } };
    function receive(line: string) {
      const frame = localFrame.parse(JSON.parse(line));
      if (frame.type === 'cancel') { pending.get(frame.id)?.abort(); return; }
      if (pending.has(frame.id) || pending.size >= 128) throw new Error('Too many or duplicate pending requests');
      const { id, operation, input } = frame;
      const abort = new AbortController();
      pending.set(id, abort);
      void (async () => {
        try {
          if (isControl(operation)) throw new IntercomError('UNSUPPORTED', 'Use the HTTP control API');
          const result = await daemon.session(connection, operation, input, abort.signal);
          respond({ type: 'response', id, result });
        } catch (error) {
          if (!(error instanceof IntercomError)) console.error(error);
          respond({ type: 'response', id, error: errorPayload(error) });
        } finally { pending.delete(id); }
      })();
    }
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      try {
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          if (Buffer.byteLength(line) > maxFrameBytes) throw new Error('Frame exceeds limit');
          receive(line);
        }
        if (Buffer.byteLength(buffer) > maxFrameBytes) throw new Error('Frame exceeds limit');
      } catch { socket.destroy(); }
    });
    socket.on('error', () => socket.destroy());
    function closePeer() {
      if (!shutdownPeers.delete(closePeer)) return;
      for (const abort of pending.values()) abort.abort();
      daemon.disconnect(connection);
      socket.destroy();
    }
    shutdownPeers.add(closePeer);
    socket.once('close', closePeer);
  });

  function stream(response: ServerResponse, after: number | undefined, limit: number | undefined) {
    let page = store.events({ after, limit });
    let cursor = page.cursor;
    let draining = false;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
    });
    function write(chunk: string) {
      if (!response.write(chunk)) draining = true;
    }
    const client = {
      flush() {
        while (!response.destroyed && !draining) {
          page = store.events({ after: cursor, limit });
          if (!page.events.length && !page.reset) return;
          cursor = page.cursor;
          write(`data: ${JSON.stringify(page)}\n\n`);
        }
      },
      close() { forget(); response.end(); },
    };
    clients.add(client);
    const heartbeat = setInterval(() => { if (!draining) write(': keepalive\n\n'); }, 15000);
    response.on('drain', () => { draining = false; client.flush(); });
    function forget() { clients.delete(client); clearInterval(heartbeat); }
    response.once('close', forget);
    write(`data: ${JSON.stringify(page)}\n\n`);
    client.flush();
  }

  function permitted(request: IncomingMessage): boolean {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ??
      request.headers.cookie?.match(/(?:^|;\s*)intercom_token=([a-f0-9]+)(?:;|$)/)?.[1];
    if (!supplied) return false;
    const bytes = Buffer.from(supplied);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!origin || request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      json(response, 403, { error: { code: 'FORBIDDEN', message: 'Use the local Intercom origin' } });
      return;
    }
    const { pathname, searchParams } = new URL(request.url ?? '/', origin);
    const method = request.method;
    const path = pathname.slice('/api/v1'.length);
    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET') { json(response, 405, {}); return; }
      const isIndex = pathname === '/';
      const asset = isIndex ? 'index.html' : /^\/assets\/[\w.-]+$/.test(pathname) ? pathname.slice(1) : undefined;
      if (!asset) { json(response, 404, {}); return; }
      const file = join(dashboard, asset);
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) { json(response, 404, {}); return; }
      const contentType = isIndex ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/css';
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        ...(isIndex ? { 'Set-Cookie': `intercom_token=${token}; HttpOnly; SameSite=Strict; Path=/api/v1` } : {}),
      });
      createReadStream(file).on('error', error => response.destroy(error)).pipe(response);
      return;
    }
    if (!permitted(request)) { json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Intercom credentials required' } }); return; }
    if (!pathname.startsWith('/api/v1/')) { json(response, 404, { error: { code: 'UNSUPPORTED', message: 'Unsupported Intercom API version' } }); return; }
    let operation: ControlOperation;
    let input: unknown = {};
    const groupId = path.match(/^\/groups\/([^/]+)\/members:move$/)?.[1];
    const messageId = path.match(/^\/messages\/([^/]+)$/)?.[1];
    if (method === 'GET' && path === '/status') operation = 'status';
    else if (method === 'GET' && path === '/groups') operation = 'listGroups';
    else if (method === 'GET' && path === '/sessions') {
      operation = 'listSessions';
      const online = searchParams.get('online');
      input = { groupId: searchParams.get('groupId') ?? undefined, online: online === 'true' ? true : online === 'false' ? false : online ?? undefined };
    } else if (method === 'POST' && path === '/groups') {
      operation = 'createGroup';
      input = await readBody(request);
    } else if (method === 'POST' && groupId) {
      operation = 'moveGroup';
      const body = await readBody(request);
      input = { ...(body && typeof body === 'object' ? body : {}), groupId: decodeURIComponent(groupId) };
    } else if (method === 'GET' && path === '/messages') {
      operation = 'listMessages';
      input = { groupId: searchParams.get('groupId') ?? undefined, before: queryInteger(searchParams, 'before'), limit: queryInteger(searchParams, 'limit') };
    } else if (method === 'GET' && messageId) {
      operation = 'getMessage';
      input = { messageId: decodeURIComponent(messageId) };
    } else if (method === 'GET' && path === '/events') {
      operation = 'readEvents';
      input = { after: queryInteger(searchParams, 'after'), limit: queryInteger(searchParams, 'limit') };
      if (request.headers.accept === 'text/event-stream') {
        const parsed = operations.readEvents.safeParse(input);
        if (!parsed.success) throw new IntercomError('INVALID_REQUEST', 'Invalid event cursor or limit');
        stream(response, parsed.data.after, parsed.data.limit);
        return;
      }
    } else { json(response, 404, { error: { code: 'NOT_FOUND', message: 'Intercom route not found' } }); return; }
    if (closing) return;
    const result = daemon.control(operation, input);
    json(response, 200, operation === 'status' ? { ...result, dashboardUrl: origin } : result);
  }

  const http = createHttpServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!(error instanceof IntercomError)) console.error(error);
      if (response.headersSent) response.destroy();
      else json(response, httpStatus(error), { error: errorPayload(error) });
    });
  });
  const port = Number(process.env.INTERCOM_HTTP_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INTERCOM_HTTP_PORT must be between 0 and 65535');
  rmSync(socketPath, { force: true });
  rmSync(endpointPath, { force: true });
  await new Promise<void>((resolve, reject) => ipc.once('error', reject).listen(socketPath, resolve));
  await new Promise<void>((resolve, reject) => http.once('error', reject).listen(port, '127.0.0.1', resolve));
  const listening = http.address();
  if (!listening || typeof listening === 'string') throw new Error('Missing HTTP listener');
  origin = `http://127.0.0.1:${listening.port}`;
  writeFileSync(`${endpointPath}.tmp`, JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
  renameSync(`${endpointPath}.tmp`, endpointPath);
  console.log(`Intercom listening at ${origin}`);
  const offlineSweep = setInterval(sweepOffline, 5 * 60 * 1000);

  function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(offlineSweep);
    for (const client of clients) client.close();
    for (const closePeer of shutdownPeers) closePeer();
    http.close();
    http.closeAllConnections();
    ipc.close(() => {
      rmSync(endpointPath, { force: true });
      store.db.close();
      lock.close();
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
