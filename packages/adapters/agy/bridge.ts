#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { errorPayload, IntercomError, maxFrameBytes } from '../../sdk/index.js';
import { runtimeDirectory } from '../../sdk/node.js';
import { agyContextFromEnv, asObject, validateAgyContext } from './host.js';
import { AgySessions, isAgyCommand, parseAgyInput, type AgyCommand, type AgyResult } from './session.js';

const entryPoint = fileURLToPath(import.meta.url);
const filename = 'agy.sock';

function readFrame(socket: Socket): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  let bytes = 0;
  const chunks: string[] = [];
  socket.setEncoding('utf8');
  socket.on('data', function onData(chunk: string) {
    const newline = chunk.indexOf('\n');
    const part = newline < 0 ? chunk : chunk.slice(0, newline);
    bytes += Buffer.byteLength(part);
    if (bytes > maxFrameBytes || newline >= 0) socket.removeListener('data', onData);
    if (bytes > maxFrameBytes) {
      reject(new IntercomError('INVALID_REQUEST', 'AGY bridge frame exceeds the maximum size'));
      return;
    }
    chunks.push(part);
    if (newline < 0) return;
    try { resolve(JSON.parse(chunks.join(''))); } catch {
      reject(new IntercomError('INVALID_REQUEST', 'AGY bridge frame must contain valid JSON'));
    }
  });
  socket.once('error', reject);
  socket.once('close', () => reject(new IntercomError('UNAVAILABLE', 'AGY bridge closed the connection')));
  return promise;
}

async function socketRequest(path: string, payload: object, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const socket = createConnection({ path, signal });
  try {
    const response = readFrame(socket);
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    const frame = asObject(await response);
    if (frame?.ok === true) return frame.result;
    const error = asObject(frame?.error);
    if (frame?.ok === false && typeof error?.code === 'string' && typeof error.message === 'string') {
      throw new IntercomError(error.code, error.message, error.details);
    }
    throw new IntercomError('UNAVAILABLE', 'AGY bridge returned an invalid response');
  } finally {
    socket.destroy();
  }
}

async function ping(path: string): Promise<boolean> {
  try {
    await socketRequest(path, { kind: 'ping' }, AbortSignal.timeout(300));
    return true;
  } catch { return false; }
}

async function ensureBridge(directory: string, signal: AbortSignal): Promise<void> {
  const path = join(directory, filename);
  if (await ping(path)) return;
  signal.throwIfAborted();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTIGRAVITY_')) delete env[key];
  }
  const child = spawn(process.execPath, [entryPoint, directory], { detached: true, stdio: 'ignore', env });
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !spawnError) {
    await delay(75, undefined, { signal });
    if (await ping(path)) return;
  }
  throw new IntercomError('UNAVAILABLE', 'Could not start the local AGY bridge');
}

export async function callAgyBridge(command: AgyCommand, input: unknown, options: {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  signal?: AbortSignal;
} = {}): Promise<AgyResult> {
  const args = parseAgyInput(command, input);
  const context = agyContextFromEnv(options.env);
  const directory = options.directory ?? runtimeDirectory(options.env);
  const askTimeout = 'timeoutMs' in args && typeof args.timeoutMs === 'number' ? args.timeoutMs : 0;
  const timeout = AbortSignal.timeout(askTimeout + 30000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    await ensureBridge(directory, signal);
    return await socketRequest(join(directory, filename), { kind: 'call', command, args, context }, signal) as AgyResult;
  } catch (error) {
    if (options.signal?.aborted) throw new IntercomError('CANCELLED', 'AGY request cancelled');
    if (timeout.aborted) throw new IntercomError('TIMEOUT', 'AGY bridge did not respond before the deadline');
    if (error instanceof IntercomError) throw error;
    throw new IntercomError('UNAVAILABLE', 'Could not reach the local AGY bridge');
  }
}

export async function startAgyBridge(directory = runtimeDirectory()): Promise<(() => Promise<void>) | undefined> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename);
  const sessions = new AgySessions(directory);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const abort = new AbortController();
    socket.setTimeout(2000, () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      abort.abort();
    });
    void (async () => {
      try {
        const request = asObject(await readFrame(socket));
        socket.setTimeout(0);
        let result: unknown;
        if (request?.kind === 'ping') result = { pid: process.pid };
        else if (request?.kind === 'call' && isAgyCommand(request.command)) {
          result = await sessions.call(request.command, request.args, validateAgyContext(request.context), abort.signal);
        } else throw new IntercomError('INVALID_REQUEST', 'Unknown AGY bridge request');
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: errorPayload(error) })}\n`);
      }
    })();
  });
  async function listen(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once('error', reject);
    server.once('listening', resolve);
    try {
      server.listen(path);
      await promise;
    } finally {
      server.removeListener('error', reject);
      server.removeListener('listening', resolve);
    }
  }
  try { await listen(); } catch (error) {
    if (asObject(error)?.code !== 'EADDRINUSE') throw error;
    let observed;
    try { observed = lstatSync(path); } catch (statError) {
      if (asObject(statError)?.code !== 'ENOENT') throw statError;
    }
    if (observed && !observed.isSocket()) throw error;
    if (observed) {
      try {
        await socketRequest(path, { kind: 'ping' }, AbortSignal.timeout(500));
        return;
      } catch (connectionError) {
        if (asObject(connectionError)?.code !== 'ECONNREFUSED') return;
      }
      try {
        const current = lstatSync(path);
        if (observed.dev === current.dev && observed.ino === current.ino) unlinkSync(path);
      } catch (statError) {
        if (asObject(statError)?.code !== 'ENOENT') throw statError;
      }
    }
    try { await listen(); } catch (listenError) {
      if (asObject(listenError)?.code === 'EADDRINUSE') return;
      throw listenError;
    }
  }
  try { chmodSync(path, 0o600); } catch (error) {
    server.close();
    throw error;
  }
  const timer = setInterval(() => { void sessions.sweep(); }, 15000);
  timer.unref();
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    clearInterval(timer);
    sessions.close();
    for (const socket of sockets) socket.destroy();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    closing = promise;
    server.close(error => error ? reject(error) : resolve());
    return closing;
  };
}

let invoked = false;
if (process.argv[1]) {
  try { invoked = realpathSync(process.argv[1]) === entryPoint; } catch {}
}
if (invoked) {
  process.umask(0o077);
  try {
    const close = await startAgyBridge(process.argv[2]);
    if (close) {
      process.once('SIGINT', () => { void close(); });
      process.once('SIGTERM', () => { void close(); });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'AGY bridge failed to start');
    process.exitCode = 1;
  }
}
