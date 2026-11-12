import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
const runtime = await mkdtemp(join(tmpdir(), 'ic-test-'));
process.env.PI_CODING_AGENT_DIR = runtime;
const { Endpoint, IntercomClient, ensureBroker } = await import('./endpoint.mjs');
const { Bridge } = await import('./bridge.mjs');

await test('isolated broker: identity, reply correlation, cancellation, and duplicate admission', async t => {
  await ensureBroker();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.close ? c.close() : c.disconnect()));
    try { process.kill(Number(await readFile(join(runtime, 'intercom/broker.pid'), 'utf8')), 'SIGTERM'); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    await rm(runtime, { recursive: true, force: true });
  });
  async function peer(name) {
    const c = new IntercomClient(); clients.push(c);
    c.on('error', () => {});
    const now = Date.now();
    await c.connect({ name, cwd: runtime, model: 'test', pid: process.pid, startedAt: now, lastActivity: now });
    return c;
  }
  const deliveries = [];
  const endpoint = new Endpoint({ id: randomUUID(), name: 'codex-test', cwd: runtime, model: 'Codex', replyTool: 'intercom_reply' }, async (id, body) => { deliveries.push({ id, body }); return { state: 'queued' }; });
  clients.push(endpoint); await endpoint.connect();
  const a = await peer('same-name');
  const b = await peer('same-name');

  await t.test('ambiguous names and self targets fail without misdelivery', async () => {
    await assert.rejects(endpoint.send('same-name', 'must not arrive'), /Ambiguous/);
    await assert.rejects(endpoint.send(endpoint.identity.id, 'self'), /same session/);
    const bridge = new Bridge();
    assert.throws(() => bridge.threadId({}), /host _meta.threadId/);
    await assert.rejects(bridge.call('intercom_send', { threadId: endpoint.identity.id, to: a.sessionId, message: 'forged' }, {}, new AbortController().signal), /intercom_join/);
    await bridge.close();
  });

  await t.test('only the addressed peer can resolve an ask, including immediate replies', async () => {
    const received = once(a, 'message');
    const answer = endpoint.ask(a.sessionId, 'question', 2000, new AbortController().signal);
    const [, question] = await received;
    await b.send(endpoint.identity.id, { text: 'wrong sender', replyTo: question.id });
    assert.equal(endpoint.waiter.id, question.id);
    await a.send(endpoint.identity.id, { text: 'correct answer', replyTo: question.id });
    assert.equal((await answer).message, 'correct answer');
    assert.equal(endpoint.waiter, null);
  });

  await t.test('abort releases a pending ask; subsequent asks still work', async () => {
    const received = once(a, 'message');
    const controller = new AbortController();
    const first = endpoint.ask(a.sessionId, 'cancel me', 2000, controller.signal);
    const rejection = assert.rejects(first, /cancelled/);
    await received;
    controller.abort();
    await rejection;
    const nextMessage = once(a, 'message');
    const next = endpoint.ask(a.sessionId, 'second', 2000, new AbortController().signal);
    const [, question] = await nextMessage;
    await a.send(endpoint.identity.id, { text: 'second answer', replyTo: question.id });
    assert.equal((await next).message, 'second answer');
  });

  await t.test('duplicate message IDs do not admit a second Codex turn', async () => {
    const id = randomUUID();
    const first = await a.send(endpoint.identity.id, { text: 'deliver once', messageId: id, expectsReply: true });
    assert.equal(first.delivered, true, JSON.stringify(first));
    const duplicate = await a.send(endpoint.identity.id, { text: 'deliver once', messageId: id, expectsReply: true });
    assert.equal(duplicate.delivered, true, JSON.stringify(duplicate));
    await endpoint.inbound;
    assert.equal(deliveries.filter(d => d.id === id).length, 1);
    const reply = once(a, 'message');
    await endpoint.reply(id, 'one correlated answer');
    const [, message] = await reply;
    assert.equal(message.replyTo, id);
    assert.equal(message.content.text, 'one correlated answer');
  });

  await t.test('AGY bridge verifies host context, rejects subagents, and delivers via SendUserCascadeMessage', async () => {
    const { AgyBridge, AgyConnection, agyContextFromEnv, startAgyDaemon, callAgyDaemon } = await import('./agy.mjs');
    const rootId = randomUUID();
    const subagentId = randomUUID();
    const sentMessages = [];
    const server = createServer(async (req, res) => {
      if (req.headers['x-codeium-csrf-token'] !== 'secret-csrf') {
        res.statusCode = 403;
        res.end(JSON.stringify({ message: 'invalid csrf' }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetConversationMetadata') {
        if (body.conversationId === rootId) {
          res.end(JSON.stringify({
            metadata: {
              rootConversationId: rootId,
              workspaceUris: [`file://${runtime}`],
            },
          }));
        } else if (body.conversationId === subagentId) {
          res.end(JSON.stringify({
            metadata: {
              rootConversationId: rootId,
              parentConversationId: rootId,
              workspaceUris: [`file://${runtime}`],
            },
          }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 'not_found', message: 'trajectory not found' }));
        }
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
        sentMessages.push(body);
        res.end(JSON.stringify({}));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const lsAddress = `127.0.0.1:${server.address().port}`;
    const socketPath = join(runtime, 'intercom/agy-test.sock');
    const bridge = new AgyBridge(new AgyConnection());
    const daemon = await startAgyDaemon(socketPath, bridge, 0);
    try {
      assert.throws(() => agyContextFromEnv({}), /ANTIGRAVITY_CONVERSATION_ID/);
      assert.throws(() => agyContextFromEnv({
        ANTIGRAVITY_CONVERSATION_ID: rootId,
        ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ tool: { conversationId: subagentId } }),
        ANTIGRAVITY_LS_ADDRESS: lsAddress,
        ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
      }), /does not match/);

      await assert.rejects(
        callAgyDaemon('intercom_join', { name: 'subagent' }, {
          ANTIGRAVITY_CONVERSATION_ID: subagentId,
          ANTIGRAVITY_LS_ADDRESS: lsAddress,
          ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
        }, socketPath),
        /Subagent conversations cannot join Intercom/,
      );

      const env = {
        ANTIGRAVITY_CONVERSATION_ID: rootId,
        ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({ tool: { conversationId: rootId } }),
        ANTIGRAVITY_LS_ADDRESS: lsAddress,
        ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
      };
      const joined = await callAgyDaemon('intercom_join', { name: 'agy-test' }, env, socketPath);
      assert.equal(joined.connected, true);
      assert.equal(joined.identity.id, rootId);
      assert.equal(joined.identity.name, 'agy-test');
      assert.equal(joined.identity.model, 'AGY');

      const msgId = randomUUID();
      const delivery = await a.send(rootId, { text: 'hello agy', messageId: msgId, expectsReply: true });
      assert.equal(delivery.delivered, true);
      const entry = bridge.endpoints.get(rootId);
      await entry.endpoint.inbound;
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].cascadeId, rootId);
      assert.equal(sentMessages[0].clientMessageId, msgId);
      assert.match(sentMessages[0].items?.[0]?.text ?? '', /hello agy/);

      const pending = await callAgyDaemon('intercom_pending', {}, env, socketPath);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, msgId);

      const replyReceived = once(a, 'message');
      await callAgyDaemon('intercom_reply', { reply_to: msgId, message: 'agy reply' }, env, socketPath);
      const [, replyMsg] = await replyReceived;
      assert.equal(replyMsg.replyTo, msgId);
      assert.equal(replyMsg.content.text, 'agy reply');
    } finally {
      await daemon?.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
});

await test('Alma admission requires the persisted user message in the correct thread', async t => {
  const { AlmaConnection } = await import('./alma.mjs');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id: 'alma-thread-a' }]));
  });
  const ws = new WebSocketServer({ server });
  const connected = once(ws, 'connection');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = new AlmaConnection(`http://127.0.0.1:${server.address().port}`);
  t.after(async () => {
    connection.close();
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  await connection.connect();
  const [socket] = await connected;
  const sent = once(socket, 'message');
  let admitted = false;
  const text = 'Intercom message 8e51: exact admission challenge';
  const delivery = connection.deliver('alma-thread-a', '8e51', text).then(value => { admitted = true; return value; });
  await sent;
  const publish = (threadId, role, body) => socket.send(JSON.stringify({
    type: 'message_added',
    data: { id: 'persisted-row', threadId, message: { role, parts: [{ type: 'text', text: body }] } },
  }));
  publish('alma-thread-b', 'user', text);
  publish('alma-thread-a', 'assistant', text);
  publish('alma-thread-a', 'user', `${text} not exact`);
  // WebSocket ordering: the pong follows handling of all preceding frames.
  const pong = once(socket, 'pong'); socket.ping(); await pong;
  assert.equal(admitted, false);
  publish('alma-thread-a', 'user', text);
  assert.deepEqual(await delivery, { state: 'queued', threadId: 'alma-thread-a', messageId: 'persisted-row' });
});
