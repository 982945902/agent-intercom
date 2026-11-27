#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { callAgyBridge } from '../../packages/adapters/agy/bridge.js';
import { isAgyCommand } from '../../packages/adapters/agy/session.js';
import { errorPayload, IntercomError, type Results } from '../../packages/sdk/index.js';
import { createLocalControlSdk } from '../../packages/sdk/node.js';

const help = `Usage: intercom [--json] <command>

Daemon and management
  daemon start | status
  status
  sessions list [--group GROUP_ID] [--online | --offline]
  group list
  group create NAME [SESSION_ID ...] [--expected SESSION_ID=VERSION ...] [--operation-id ID]
  group move GROUP_ID SESSION_ID ... [--expected SESSION_ID=VERSION ...] [--operation-id ID]
  group add | remove GROUP_ID SESSION_ID ... [--expected SESSION_ID=VERSION ...] [--operation-id ID]
  messages [list] [--group GROUP_ID] [--before TIMESTAMP] [--limit COUNT]
  messages get MESSAGE_ID

Run from Antigravity's run_command
  agy join [NAME | --name NAME]
  agy list | groups | status | pending
  agy send TO TEXT [--group GROUP_ID] [--client-request-id ID]
  agy ask TO TEXT [--group GROUP_ID] [--timeout-ms MILLISECONDS]
  agy reply MESSAGE_ID TEXT [--client-request-id ID]
  agy broadcast TEXT [--group GROUP_ID] [--client-request-id ID]

--json prints exactly one JSON response with ok and result or error.
Exit status: 0 success, 1 operation failed, 2 invalid input, 3 unavailable or not joined,
4 timeout, 130 cancelled.`;

const options = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  group: { type: 'string' },
  online: { type: 'boolean' },
  offline: { type: 'boolean' },
  expected: { type: 'string', multiple: true },
  'operation-id': { type: 'string' },
  'client-request-id': { type: 'string' },
  'timeout-ms': { type: 'string' },
  name: { type: 'string' },
  before: { type: 'string' },
  limit: { type: 'string' },
} as const;

type Value = Results[keyof Results] | { help: string };

function integer(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return;
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number)) {
    throw new IntercomError('INVALID_REQUEST', `${name} must be a whole number`);
  }
  return number;
}

async function daemonStart(signal: AbortSignal): Promise<Results['status']> {
  try { return await createLocalControlSdk().status(); } catch (error) {
    if (error instanceof IntercomError && error.code !== 'UNAVAILABLE') throw error;
  }
  signal.throwIfAborted();
  const entry = fileURLToPath(new URL('../daemon/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' });
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 5000;
  while (!spawnError && Date.now() < deadline) {
    await delay(75, undefined, { signal });
    try { return await createLocalControlSdk().status(); } catch (error) {
      if (error instanceof IntercomError && error.code !== 'UNAVAILABLE') throw error;
    }
  }
  throw new IntercomError('UNAVAILABLE', 'Could not start the local Intercom daemon');
}

async function run(argv: string[], signal: AbortSignal): Promise<Value> {
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true }); } catch (error) {
    throw new IntercomError('INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid command line');
  }
  const { positionals: [root, ...rest], values } = parsed;
  if (values.help) return { help };
  function allow(...flags: (keyof typeof options)[]): void {
    for (const name of Object.keys(values)) {
      if (name !== 'json' && !flags.some(flag => flag === name)) {
        throw new IntercomError('INVALID_REQUEST', `--${name} is not valid for this command`);
      }
    }
  }
  function count(args: string[], min: number, max = min): void {
    if (args.length < min || args.length > max) {
      throw new IntercomError('INVALID_REQUEST', 'Unexpected number of arguments. Run intercom --help for usage.');
    }
  }

  if (!root) {
    allow();
    return { help };
  }
  if (root === 'agy') {
    const [raw, ...args] = rest;
    if (!isAgyCommand(raw)) throw new IntercomError('INVALID_REQUEST', 'Unknown AGY command. Run intercom --help for usage.');
    let input: Record<string, unknown>;
    switch (raw) {
      case 'join':
        allow('name');
        count(args, 0, values.name === undefined ? 1 : 0);
        input = { name: values.name ?? args[0] };
        break;
      case 'send':
        allow('group', 'client-request-id');
        count(args, 2);
        input = { to: args[0], text: args[1], groupId: values.group, clientRequestId: values['client-request-id'] };
        break;
      case 'ask':
        allow('group', 'timeout-ms');
        count(args, 2);
        input = { to: args[0], text: args[1], groupId: values.group, timeoutMs: integer(values['timeout-ms'], '--timeout-ms') };
        break;
      case 'reply':
        allow('client-request-id');
        count(args, 2);
        input = { replyTo: args[0], text: args[1], clientRequestId: values['client-request-id'] };
        break;
      case 'broadcast':
        allow('group', 'client-request-id');
        count(args, 1);
        input = { text: args[0], groupId: values.group, clientRequestId: values['client-request-id'] };
        break;
      default:
        allow();
        count(args, 0);
        input = {};
    }
    return await callAgyBridge(raw, input, { signal });
  }

  const [child, ...args] = rest;
  if (root === 'daemon' && child === 'start') {
    allow();
    count(args, 0);
    return daemonStart(signal);
  }
  if (root === 'status' || (root === 'daemon' && child === 'status')) {
    allow();
    count(root === 'daemon' ? args : rest, 0);
    return createLocalControlSdk().status();
  }
  if (root === 'list' || (root === 'sessions' && child === 'list')) {
    allow('group', 'online', 'offline');
    count(root === 'sessions' ? args : rest, 0);
    if (values.online && values.offline) throw new IntercomError('INVALID_REQUEST', 'Choose either --online or --offline');
    return createLocalControlSdk().listSessions({ groupId: values.group, online: values.offline ? false : values.online });
  }
  if ((root === 'group' || root === 'groups') && child === 'list') {
    allow();
    count(args, 0);
    return createLocalControlSdk().listGroups();
  }
  if ((root === 'group' || root === 'groups') && (child === 'create' || child === 'move' || child === 'add' || child === 'remove')) {
    allow('expected', 'operation-id');
    count(args, child === 'create' ? 1 : 2, 101);
    const [destination, ...sessionIds] = args;
    const expected: [string, number][] = [];
    for (const value of values.expected ?? []) {
      const separator = value.lastIndexOf('=');
      const version = separator > 0 ? integer(value.slice(separator + 1), '--expected version') : undefined;
      if (!version) throw new IntercomError('INVALID_REQUEST', '--expected requires SESSION_ID=VERSION');
      expected.push([value.slice(0, separator), version]);
    }
    const membership = {
      sessionIds,
      expectedMembershipVersions: expected.length ? Object.fromEntries(expected) : undefined,
      operationId: values['operation-id'],
    };
    const sdk = createLocalControlSdk();
    if (child === 'create') return sdk.createGroup({ ...membership, name: destination! });
    const input = { ...membership, groupId: destination! };
    if (child === 'add') return sdk.addGroupMembers(input);
    if (child === 'remove') return sdk.removeGroupMembers(input);
    return sdk.moveGroup(input);
  }
  if (root === 'messages' && (child === undefined || child === 'list')) {
    allow('group', 'before', 'limit');
    count(args, 0);
    return createLocalControlSdk().listMessages({
      groupId: values.group, before: integer(values.before, '--before'), limit: integer(values.limit, '--limit'),
    });
  }
  if (root === 'messages' && child === 'get') {
    allow();
    count(args, 1);
    return createLocalControlSdk().getMessage({ messageId: args[0]! });
  }
  throw new IntercomError('INVALID_REQUEST', 'Unknown command. Run intercom --help for usage.');
}

function human(value: Value): string {
  if ('help' in value) return value.help;
  if (Array.isArray(value)) {
    if (!value.length) return 'No results.';
    return value.map(row => {
      if ('adapterKind' in row) return `${row.id}\t${JSON.stringify(row.name)}\t${row.adapterKind}\t${(row.groupIds ?? [row.groupId]).join(', ')}\t${row.online ? 'online' : 'offline'}`;
      if ('members' in row) return `${row.id}\t${JSON.stringify(row.name)}\t${row.members.length} members`;
      if ('version' in row) return `${row.id}\t${JSON.stringify(row.name)}`;
      return `${row.id}\t${JSON.stringify(row.fromName)}\t${JSON.stringify(row.text)}`;
    }).join('\n');
  }
  if ('onlineSessions' in value) {
    const status = `Intercom protocol v${value.protocolVersion}, ${value.onlineSessions} online session(s)`;
    return value.dashboardUrl ? `${status}\nDashboard ${value.dashboardUrl}` : status;
  }
  if ('adapterKind' in value) return `${JSON.stringify(value.name)} (${value.id}) is ${value.online ? 'online' : 'offline'} in ${(value.groupIds ?? [value.groupId]).join(', ')}`;
  return JSON.stringify(value, null, 2);
}

const argv = process.argv.slice(2);
const endFlags = argv.indexOf('--');
const json = argv.slice(0, endFlags < 0 ? argv.length : endFlags).includes('--json');
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const result = await run(argv, controller.signal);
  console.log(json ? JSON.stringify({ ok: true, result }) : human(result));
} catch (error) {
  const failure = controller.signal.aborted ? new IntercomError('CANCELLED', 'Intercom command cancelled') : error;
  const payload = errorPayload(failure);
  if (json) console.log(JSON.stringify({ ok: false, error: payload }));
  else console.error(`${payload.code} ${payload.message}`);
  switch (payload.code) {
    case 'INVALID_REQUEST':
    case 'AGY_CONTEXT_REQUIRED':
    case 'AGY_INVALID_CONTEXT':
    case 'AGY_SUBAGENT': process.exitCode = 2; break;
    case 'UNAVAILABLE':
    case 'NOT_JOINED':
    case 'AGY_HOST_GONE':
    case 'AGY_CONVERSATION_GONE': process.exitCode = 3; break;
    case 'TIMEOUT':
    case 'TIMED_OUT':
    case 'ASK_TIMEOUT': process.exitCode = 4; break;
    case 'CANCELLED': process.exitCode = 130; break;
    default: process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
