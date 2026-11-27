import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureBroker, IntercomClient } from '../dist/packages/adapters/joyme-watch/endpoint.js';
import intercomExtension from '../dist/packages/adapters/omp/index.js';
import { createLocalControlSdk, openLocalSession } from '../dist/packages/sdk/node.js';

const daemon = fileURLToPath(new URL('../dist/apps/daemon/index.js', import.meta.url));
const cli = fileURLToPath(new URL('../dist/apps/cli/index.js', import.meta.url));
const run = promisify(execFile);

async function eventually(work) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await work();
    if (result) return result;
    await delay(25);
  }
  assert.fail('Condition did not resolve before deadline');
}

async function startDaemon(directory) {
  const env = { ...process.env, INTERCOM_RUNTIME_DIR: directory, INTERCOM_HTTP_PORT: '0' };
  const child = spawn(process.execPath, [daemon], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  const exited = once(child, 'exit');
  async function close() {
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, diagnostic);
  }
  try {
    await eventually(async () => {
      if (child.exitCode !== null) assert.fail(`Daemon exited: ${diagnostic}`);
      try { return await createLocalControlSdk(directory).status(); }
      catch (error) { if (error.code === 'UNAVAILABLE') return null; throw error; }
    });
  } catch (error) { await close(); throw error; }
  return { child, env, close };
}

async function connect(directory, adapterKind, name, received) {
  return openLocalSession({ adapterKind, hostInstanceId: 'test', nativeSessionId: name, name }, async (event, sdk) => {
    await sdk.receipt({ deliveryId: event.delivery.id, state: 'host_accepted', source: adapterKind });
    received.push(event.message);
  }, { directory });
}

test('routing, receipts, active asks, group moves and membership survive reconnect', { timeout: 20000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  let server;
  const sessions = [];
  try {
    server = await startDaemon(directory);
    const control = createLocalControlSdk(directory);
    const inbox = [];
    const omp = await connect(directory, 'omp', 'omp-test', []);
    sessions.push(omp);
    const agy = await connect(directory, 'agy', 'agy-test', inbox);
    sessions.push(agy);
    const other = await connect(directory, 'omp', 'other', []);
    sessions.push(other);
    const first = await omp.sdk.sessionStatus();
    const second = await agy.sdk.sessionStatus();
    const third = await other.sdk.sessionStatus();
    assert.equal(second.groupId, 'default');
    assert.equal((await omp.sdk.listPeers()).length, 2);

    const controller = new AbortController();
    const stream = control.events(undefined, controller.signal)[Symbol.asyncIterator]();
    try {
      const initial = (await stream.next()).value;
      assert.equal(initial.reset, true);
      const request = omp.sdk.ask({ to: second.id, text: 'confirm membership', timeoutMs: 5000 });
      const incoming = await eventually(() => inbox.find(message => message.kind === 'ask'));
      const destination = await control.createGroup({ name: 'pair', sessionIds: [] });
      await assert.rejects(control.moveGroup({ groupId: destination.group.id, sessionIds: [first.id, second.id] }), { code: 'ACTIVE_ASK' });
      assert.equal((await control.getMessage({ messageId: incoming.id })).deliveries[0].state, 'host_accepted');
      await agy.sdk.reply({ replyTo: incoming.id, text: 'confirmed' });
      assert.equal((await request).reply.text, 'confirmed');

      const { stdout } = await run(process.execPath, [cli, 'daemon', 'status', '--json'], { env: server.env });
      assert.match(stdout, /onlineSessions/);
      const { group } = await control.moveGroup({ groupId: destination.group.id, sessionIds: [first.id, second.id] });
      const updated = await stream.next();
      assert.ok(updated.value.cursor > initial.cursor);
      assert.deepEqual((await omp.sdk.listPeers()).map(peer => peer.id), [second.id]);
      await assert.rejects(other.sdk.send({ to: second.id, text: 'blocked' }), { code: 'CROSS_GROUP' });
      const broadcast = await thirdPeerBroadcast(other, third.id);
      assert.equal(broadcast.deliveries.length, 0);

      const outgoing = { to: second.id, text: 'same transaction', clientRequestId: 'same-key' };
      const sent = await omp.sdk.send(outgoing);
      assert.equal((await omp.sdk.send(outgoing)).message.id, sent.message.id);
      await assert.rejects(omp.sdk.send({ ...outgoing, text: 'changed' }), { code: 'OPERATION_CONFLICT' });
      await eventually(() => inbox.find(message => message.id === sent.message.id));

      await server.close();
      server = await startDaemon(directory);
      await eventually(async () => (await createLocalControlSdk(directory).status()).onlineSessions === 3);
      assert.equal((await agy.sdk.sessionStatus()).id, second.id);
      assert.equal((await agy.sdk.sessionStatus()).groupId, group.id);
      assert.equal((await createLocalControlSdk(directory).getMessage({ messageId: sent.message.id })).deliveries[0].state, 'host_accepted');
      await assert.rejects(other.sdk.send({ to: first.id, text: 'still blocked' }), { code: 'CROSS_GROUP' });
    } finally {
      controller.abort();
      await stream.return();
    }
  } finally {
    for (const session of sessions) session.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('coordination membership preserves business groups and restricts message routes', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  let server;
  const connections = [];
  try {
    server = await startDaemon(directory);
    const control = createLocalControlSdk(directory);
    const inbox = [];
    for (const name of ['leader-a', 'member-a', 'leader-b', 'member-b']) {
      connections.push(await connect(directory, 'omp', name, inbox));
    }
    const [a, memberA, b, memberB] = connections.map(connection => connection.sdk);
    const [aId, memberAId, bId, memberBId] = (await Promise.all(connections.map(c => c.sdk.sessionStatus()))).map(s => s.id);
    const { group: groupA } = await control.createGroup({ name: 'Business A', sessionIds: [] });
    const { group: groupB } = await control.createGroup({ name: 'Business B', sessionIds: [] });
    await control.moveGroup({ groupId: groupA.id, sessionIds: [aId, memberAId] });
    await control.moveGroup({ groupId: groupB.id, sessionIds: [bId, memberBId] });
    const { group: coordination } = await control.createGroup({ name: 'Coordination', sessionIds: [aId, bId] });

    assert.deepEqual(new Set((await a.myGroups()).map(group => group.id)), new Set([groupA.id, coordination.id]));
    const visible = await a.listPeers();
    assert.deepEqual(visible.map(peer => [peer.id, peer.groupIds]), [[bId, [coordination.id]], [memberAId, [groupA.id]]]);
    assert.deepEqual((await memberA.listPeers()).map(peer => [peer.id, peer.groupIds]), [[aId, [groupA.id]]]);
    await assert.rejects(memberA.send({ to: bId, text: 'No transitive visibility' }), { code: 'CROSS_GROUP' });
    await assert.rejects(a.send({ to: bId, groupId: groupA.id, text: 'Wrong group' }), { code: 'CROSS_GROUP' });
    await assert.rejects(a.broadcast({ text: 'Missing group' }), { code: 'GROUP_REQUIRED' });
    const broadcast = await a.broadcast({ groupId: groupA.id, text: 'Only business A' });
    assert.deepEqual(broadcast.deliveries.map(delivery => delivery.toSessionId), [memberAId]);

    const request = a.ask({ to: bId, text: 'Coordinate', timeoutMs: 3000 });
    void request.catch(() => {});
    const incoming = await eventually(() => inbox.find(message => message.text === 'Coordinate'));
    assert.equal(incoming.groupIdAtAccept, coordination.id);
    await control.removeGroupMembers({ groupId: groupA.id, sessionIds: [aId] });
    await assert.rejects(control.removeGroupMembers({ groupId: coordination.id, sessionIds: [aId] }), { code: 'ACTIVE_ASK' });
    await b.reply({ replyTo: incoming.id, text: 'Coordinated' });
    assert.equal((await request).reply.groupIdAtAccept, coordination.id);

    const { stdout } = await run(process.execPath, [cli, 'group', 'add', groupA.id, aId, '--json'], { env: server.env });
    assert.deepEqual(new Set(JSON.parse(stdout).result.sessions[0].groupIds), new Set([groupA.id, coordination.id]));
    assert.deepEqual((await memberB.listPeers()).map(peer => peer.id), [bId]);
    await control.addGroupMembers({ groupId: groupA.id, sessionIds: [bId] });
    assert.equal((await a.listPeers()).filter(peer => peer.id === bId).length, 1);
    await assert.rejects(a.send({ to: bId, text: 'Choose common group' }), { code: 'GROUP_REQUIRED' });
    await a.send({ to: bId, groupId: coordination.id, text: 'Scoped direct' });
    await server.close();
    server = undefined;
    server = await startDaemon(directory);
    await eventually(async () => (await createLocalControlSdk(directory).status()).onlineSessions === 4);
    assert.deepEqual(new Set((await a.sessionStatus()).groupIds), new Set([groupA.id, coordination.id]));
    assert.equal((await a.sessionStatus()).id, aId);
  } finally {
    for (const connection of connections) connection.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('JoyME Watch can reply and notify its subscriber across group changes', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  const previous = process.env.INTERCOM_RUNTIME_DIR;
  process.env.INTERCOM_RUNTIME_DIR = directory;
  const watcher = new IntercomClient();
  const identity = { adapterKind: 'service', hostInstanceId: 'local', nativeSessionId: 'joyme-watch' };
  const connections = [];
  let server;
  try {
    server = await startDaemon(directory);
    const control = createLocalControlSdk(directory);
    await assert.rejects(openLocalSession(identity, async () => {}, { directory }), { code: 'SERVICE_UNAUTHORIZED' });
    const inbox = [];
    const subscriber = await connect(directory, 'omp', 'subscriber', inbox);
    const unrelated = await connect(directory, 'agy', 'unrelated', []);
    connections.push(subscriber, unrelated);
    const subscriberId = (await subscriber.sdk.sessionStatus()).id;
    const otherId = (await unrelated.sdk.sessionStatus()).id;
    await ensureBroker();
    await watcher.connect({ cwd: directory });
    assert.deepEqual(new Set((await watcher.listSessions()).map(peer => peer.id)), new Set([subscriberId, otherId]));
    const system = (await control.listGroups()).find(group => group.id === 'system');
    assert.equal(system.members.length, 3);
    await assert.rejects(control.addGroupMembers({ groupId: system.id, sessionIds: [subscriberId] }), { code: 'SYSTEM_GROUP_READ_ONLY' });
    assert.equal((await watcher.send(otherId, { text: 'No subscription' })).delivered, false);
    await assert.rejects(subscriber.sdk.broadcast({ groupId: system.id, text: 'No global broadcast' }), { code: 'CROSS_GROUP' });

    const subscribed = once(watcher, 'message');
    watcher.on('message', (_, message) => watcher.sendMessageReceipt({ messageId: message.id, status: 'acknowledged', timestamp: Date.now() }));
    const request = subscriber.sdk.ask({ to: 'joyme-watch', text: 'watch user fixture', timeoutMs: 3000 });
    void request.catch(() => {});
    const [from, command] = await subscribed;
    assert.equal(from.id, subscriberId);
    assert.equal(command.expectsReply, true);
    const { group } = await control.createGroup({ name: 'New work', sessionIds: [] });
    await control.moveGroup({ groupId: group.id, sessionIds: [subscriberId] });
    assert.equal((await watcher.send(from.id, { text: 'Subscribed', replyTo: command.id })).delivered, true);
    assert.equal((await request).reply.text, 'Subscribed');
    for (const text of ['list all', 'unwatch all global', JSON.stringify({ action: 'renew', watch_id: `${otherId}::user:fixture` })]) {
      await assert.rejects(subscriber.sdk.ask({ to: 'joyme-watch', text, timeoutMs: 3000 }), { code: 'HOST_REJECTED' });
    }
    const notification = await watcher.send(from.id, { text: 'New JoyME message' });
    assert.equal(notification.delivered, true);
    assert.equal(inbox.find(message => message.id === notification.id).groupIdAtAccept, system.id);
    subscriber.close();
    await eventually(async () => (await control.listSessions({ online: false })).some(session => session.id === subscriberId));
    assert.equal((await watcher.send(from.id, { text: 'Subscriber offline' })).delivered, false);
    const disconnected = once(watcher, 'disconnected');
    await server.close();
    server = undefined;
    await disconnected;
    assert.equal(watcher.isConnected(), false);
  } finally {
    await watcher.disconnect();
    for (const connection of connections) connection.close();
    if (previous === undefined) delete process.env.INTERCOM_RUNTIME_DIR;
    else process.env.INTERCOM_RUNTIME_DIR = previous;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup archives stale offline sessions and preserves history and resume identity', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  let server;
  const connections = [];
  try {
    server = await startDaemon(directory);
    const control = createLocalControlSdk(directory);
    const old = await connect(directory, 'agy', 'stale-peer', []);
    const recent = await connect(directory, 'omp', 'recent-peer', []);
    connections.push(old, recent);
    const [stale, current] = await Promise.all(connections.map(connection => connection.sdk.sessionStatus()));
    const { group } = await control.createGroup({ name: 'retention', sessionIds: [stale.id, current.id] });
    await control.moveGroup({ groupId: group.id, sessionIds: [stale.id, current.id] });
    const sent = await recent.sdk.send({ to: stale.id, text: 'Keep this history' });
    await old.sdk.rename({ name: 'saved-alias' });
    old.close();
    await eventually(async () => (await control.listSessions({ online: false })).length === 1);
    recent.close();
    await server.close();
    server = undefined;

    const db = new DatabaseSync(join(directory, 'intercom.sqlite'));
    try {
      db.exec(`DROP TABLE group_members; DROP INDEX messages_sender_group; DELETE FROM groups WHERE id = 'system';
        DROP INDEX sessions_offline; ALTER TABLE sessions DROP COLUMN archived; ALTER TABLE sessions DROP COLUMN offline_since; PRAGMA user_version = 1`);
      db.prepare(`UPDATE events SET timestamp = ? WHERE type = 'session' AND json_extract(payload, '$.sessionId') = ?
        AND json_extract(payload, '$.state') = 'offline'`).run(Date.now() - 25 * 60 * 60 * 1000, stale.id);
    } finally { db.close(); }

    server = await startDaemon(directory);
    const restarted = createLocalControlSdk(directory);
    assert.deepEqual((await restarted.listSessions({ online: false })).map(session => session.id), [current.id]);
    assert.deepEqual((await restarted.listGroups()).find(item => item.id === group.id).members.map(session => session.id), [current.id]);
    assert.equal((await restarted.getMessage({ messageId: sent.message.id })).deliveries[0].toSessionId, stale.id);
    assert.ok((await restarted.readEvents({ after: 0 })).events.some(event => event.sessionId === stale.id && event.state === 'archived'));

    const resumed = await openLocalSession({ adapterKind: 'agy', hostInstanceId: 'test', nativeSessionId: 'stale-peer' },
      async () => {}, { directory });
    connections.push(resumed);
    const presence = await resumed.sdk.sessionStatus();
    assert.equal(presence.id, stale.id);
    assert.equal(presence.name, 'saved-alias');
    assert.equal(presence.groupId, group.id);
    assert.deepEqual(presence.groupIds, [group.id]);
    assert.deepEqual((await restarted.listSessions({ online: true })).map(session => session.id), [stale.id]);
  } finally {
    for (const connection of connections) connection.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('OMP acknowledges native admission before the turn finishes and shows late reply correlation', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  const oldDirectory = process.env.INTERCOM_RUNTIME_DIR;
  process.env.INTERCOM_RUNTIME_DIR = directory;
  const handlers = new Map();
  const commands = new Map();
  const prompts = [];
  let input;
  const tools = new Map();
  const submitted = [];
  const ctx = {
    agent: { kind: 'main' }, hasUI: true, cwd: directory, sessionManager: { getSessionId: () => 'native-omp' },
    ui: { setStatus() {}, notify() {}, async input(title, placeholder) { prompts.push({ title, placeholder }); return input; } },
  };
  intercomExtension({
    on: (event, handler) => handlers.set(event, handler),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage(text) {
      const result = Promise.withResolvers();
      submitted.push({ text, ...result });
      return result.promise;
    },
  });
  let server;
  let peer;
  try {
    server = await startDaemon(directory);
    const control = createLocalControlSdk(directory);
    const inbox = [];
    peer = await connect(directory, 'agy', 'late-reply-peer', inbox);
    handlers.get('session_start')({}, ctx);
    handlers.get('session_start')({}, {
      ...ctx, agent: { kind: 'sub' }, sessionManager: { getSessionId: () => 'native-omp-sub' },
    });
    const omp = await eventually(async () => (await peer.sdk.listPeers()).find(session => session.nativeSessionId === 'native-omp'));

    const sent = await peer.sdk.send({ to: omp.id, text: 'Start the native turn' });
    const first = await eventually(() => submitted[0]);
    const emit = (text, attribution) => handlers.get('message_end')({
      message: { role: 'user', attribution, content: [{ type: 'text', text }] },
    }, ctx);
    const delivery = async id => (await control.getMessage({ messageId: id })).deliveries[0].state;
    emit(first.text, 'user');
    assert.equal(await delivery(sent.message.id), 'adapter_received');
    emit(first.text.replace('Start the native turn', 'Text after native mention expansion'), 'agent');
    await eventually(async () => await delivery(sent.message.id) === 'host_accepted');
    first.reject(new Error('An error after the host accepted the message'));

    const rejected = await peer.sdk.send({ to: omp.id, text: 'Prompt dropped before admission' });
    const second = await eventually(() => submitted[1]);
    second.reject(Object.assign(new Error('Dropped by OMP'), { name: 'PromptDroppedError' }));
    await eventually(async () => await delivery(rejected.message.id) === 'rejected');

    const recipient = (await peer.sdk.sessionStatus()).id;
    await assert.rejects(tools.get('intercom_ask').execute('test', {
      to: recipient, text: 'Expire this ask', timeoutMs: 20,
    }, undefined, undefined, ctx), { code: 'ASK_TIMEOUT' });
    const ask = await eventually(() => inbox.find(message => message.kind === 'ask'));
    const reply = await peer.sdk.reply({ replyTo: ask.id, text: 'Late answer' });
    const late = await eventually(() => submitted[2]);
    assert.equal(late.text, `[Intercom late reply] From late-reply-peer\nMessage ID: ${reply.message.id}\nIn reply to ask: ${ask.id}\n\nLate answer`);
    late.resolve();
    await eventually(async () => await delivery(reply.message.id) === 'host_accepted');

    const { group } = await control.createGroup({ name: 'resume', sessionIds: [omp.id] });
    handlers.get('session_shutdown')({}, ctx);
    await eventually(async () => (await control.listSessions({ groupId: group.id, online: false })).length === 1);
    handlers.get('session_start')({}, ctx);
    const resumed = await eventually(async () => (await control.listSessions({ groupId: group.id, online: true }))[0]);
    assert.equal(resumed.id, omp.id);
    assert.equal(resumed.name, omp.name);
    assert.deepEqual((await control.listSessions({})).map(session => session.id).sort(), [recipient, omp.id].sort());

    await commands.get('intercom-id').handler('', ctx);
    assert.deepEqual(prompts, [{ title: 'Set Intercom alias', placeholder: `Current alias: ${omp.name}` }]);
    assert.equal((await control.listSessions({ groupId: group.id }))[0].name, omp.name);
    input = '  dialog-alias  ';
    await commands.get('intercom-id').handler('', ctx);
    assert.equal((await control.listSessions({ groupId: group.id }))[0].name, 'dialog-alias');
    await commands.get('intercom-alias').handler('inline-alias', ctx);
    assert.equal((await control.listSessions({ groupId: group.id }))[0].name, 'inline-alias');
    assert.equal(prompts.length, 2);
  } finally {
    handlers.get('session_shutdown')({}, ctx);
    for (const submission of submitted) submission.resolve();
    peer?.close();
    if (oldDirectory === undefined) delete process.env.INTERCOM_RUNTIME_DIR;
    else process.env.INTERCOM_RUNTIME_DIR = oldDirectory;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('AGY session commands require the agy namespace', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  let server;
  try {
    server = await startDaemon(directory);
    const env = { ...server.env, ANTIGRAVITY_CONVERSATION_ID: 'invalid' };
    const call = (...args) => run(process.execPath, [cli, ...args, '--json'], { env });
    const status = JSON.parse((await call('status')).stdout);
    assert.equal(status.result.onlineSessions, 0);
    const list = JSON.parse((await call('list')).stdout);
    assert.deepEqual(list.result, []);
    for (const args of [['intercom_join', '{"name":"legacy"}'], ['join', 'implicit']]) {
      await assert.rejects(call(...args), error => JSON.parse(error.stdout).error.code === 'INVALID_REQUEST');
    }
    await assert.rejects(call('agy', 'join'), error => JSON.parse(error.stdout).error.code === 'AGY_CONTEXT_REQUIRED');
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function thirdPeerBroadcast(peer, id) {
  const record = await peer.sdk.broadcast({ text: 'default only' });
  assert.equal(record.message.fromSessionId, id);
  return record;
}

test('Dashboard HTTP origin and daemon ownership are enforced', { timeout: 10000 }, async () => {
  const directory = await mkdtemp('/tmp/intercom-test-');
  let server;
  try {
    server = await startDaemon(directory);
    const { origin, token } = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'));
    const second = await run(process.execPath, [daemon], { env: server.env }).catch(error => error);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already running/);
    assert.equal((await fetch(`${origin}/api/v1/status`)).status, 401);
    const headers = { Authorization: `Bearer ${token}`, Origin: 'https://example.invalid' };
    assert.equal((await fetch(`${origin}/api/v1/status`, { headers })).status, 403);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Intercom/);
    const cookie = page.headers.getSetCookie()[0].split(';')[0];
    const authorized = await fetch(`${origin}/api/v1/status`, { headers: { Cookie: cookie } });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).protocolVersion, 1);
    const { stdout } = await run(process.execPath, [cli, 'daemon', 'start'], { env: server.env });
    assert.ok(stdout.includes(`Dashboard ${origin}`));
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
