import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
      await assert.rejects(control.createGroup({ name: 'blocked', sessionIds: [first.id, second.id] }), { code: 'ACTIVE_ASK' });
      assert.equal((await control.listGroups()).length, 1);
      assert.equal((await control.getMessage({ messageId: incoming.id })).deliveries[0].state, 'host_accepted');
      await agy.sdk.reply({ replyTo: incoming.id, text: 'confirmed' });
      assert.equal((await request).reply.text, 'confirmed');

      const { stdout } = await run(process.execPath, [cli, 'daemon', 'status', '--json'], { env: server.env });
      assert.match(stdout, /onlineSessions/);
      const { group } = await control.createGroup({ name: 'pair', sessionIds: [first.id, second.id] });
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
