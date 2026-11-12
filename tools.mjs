const text = { type: 'string', minLength: 1, maxLength: 65536 };
const target = { type: 'string', minLength: 1, maxLength: 256 };
const definitions = [
  ['intercom_join', 'Join this existing conversation to Intercom. Call once before other tools. The host supplies your true thread identity; name optionally names this thread. Never supply another thread ID.', { name: { type: 'string', minLength: 1, maxLength: 80 } }, [], false],
  ['intercom_list', 'List live joined OMP, Codex, Alma and AGY peers. Target a unique name or full ID; names may collide.', {}, [], true],
  ['intercom_status', 'Show this conversation’s stable Intercom identity and connection state.', {}, [], true],
  ['intercom_send', 'Send a message to an existing live peer. Can start agent work under the recipient’s existing permissions. Delivery is not proof of model completion.', { to: target, message: text }, ['to', 'message'], false],
  ['intercom_ask', 'Ask a live peer and wait for its exactly correlated reply. Only one pending ask per session. Timeout stops waiting, not the recipient’s work. Prefer send unless blocked.', { to: target, message: text, timeout_ms: { type: 'integer', minimum: 1, maximum: 600000 } }, ['to', 'message'], false],
  ['intercom_reply', 'Reply to a received message. Use its exact message ID as reply_to, especially when several peers are talking. Does not guess the sender.', { reply_to: target, message: text }, ['message'], false],
  ['intercom_pending', 'List unanswered inbound messages and their reply_to IDs.', {}, [], true],
];
export const tools = definitions.map(([name, description, properties, required, readOnlyHint]) => ({
  name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: !readOnlyHint },
  _meta: { 'alma/outputSafetyMode': 'exact' },
}));

export function validate(tool, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) throw new Error(`Unexpected argument: ${key}`);
    if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength)) throw new Error(`Invalid ${key}`);
    if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) throw new Error(`Invalid ${key}`);
  }
}
