import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IntercomError } from '../../sdk/index.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const service = '/exa.language_server_pb.LanguageServerService';

export interface AgyContext {
  conversationId: string;
  lsAddress: string;
  csrfToken: string;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function validateAgyContext(value: unknown): AgyContext {
  const { conversationId, lsAddress, csrfToken } = asObject(value) ?? {};
  if (typeof conversationId !== 'string' || !uuid.test(conversationId)) {
    throw new IntercomError('AGY_CONTEXT_REQUIRED', 'AGY run_command must provide ANTIGRAVITY_CONVERSATION_ID');
  }
  if (typeof lsAddress !== 'string' || typeof csrfToken !== 'string' || !lsAddress.trim() || !csrfToken.trim()) {
    throw new IntercomError('AGY_CONTEXT_REQUIRED', 'AGY run_command must provide ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN');
  }
  const address = lsAddress.trim();
  let url: URL | undefined;
  try { url = new URL(address.includes('://') ? address : `http://${address}`); } catch {}
  if (!url || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new IntercomError('AGY_INVALID_CONTEXT', 'AGY requires a local HTTP Language Server address with a port');
  }
  return { conversationId, lsAddress: url.origin, csrfToken: csrfToken.trim() };
}

export function agyContextFromEnv(env: NodeJS.ProcessEnv = process.env): AgyContext {
  const context = validateAgyContext({
    conversationId: env.ANTIGRAVITY_CONVERSATION_ID,
    lsAddress: env.ANTIGRAVITY_LS_ADDRESS,
    csrfToken: env.ANTIGRAVITY_CSRF_TOKEN,
  });
  const rawSource = env.ANTIGRAVITY_SOURCE_METADATA;
  if (rawSource) {
    let source: Record<string, unknown> | undefined;
    try { source = asObject(JSON.parse(rawSource)); } catch {}
    if (!source) throw new IntercomError('AGY_INVALID_CONTEXT', 'Invalid ANTIGRAVITY_SOURCE_METADATA from AGY');
    const sourceConversation = asObject(source.tool)?.conversationId;
    if (sourceConversation !== undefined && sourceConversation !== context.conversationId) {
      throw new IntercomError('AGY_INVALID_CONTEXT', 'ANTIGRAVITY_CONVERSATION_ID does not match ANTIGRAVITY_SOURCE_METADATA');
    }
  }
  return context;
}

async function request(context: AgyContext, method: string, body: object): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${context.lsAddress}${service}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': context.csrfToken },
      redirect: 'error',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const code = error instanceof Error ? asObject(error.cause)?.code : undefined;
    if (code === 'ECONNREFUSED') {
      throw new IntercomError('AGY_HOST_GONE', 'The AGY Language Server is no longer listening');
    }
    throw new IntercomError('UNAVAILABLE', `AGY ${method} did not return a response`);
  }
  if (response.ok) return response;
  void response.body?.cancel().catch(() => {});
  const message = `AGY ${method} returned HTTP ${response.status}`;
  switch (response.status) {
    case 401:
    case 403: throw new IntercomError('AGY_HOST_GONE', message);
    case 404: throw new IntercomError('AGY_CONVERSATION_GONE', message);
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    throw new IntercomError('AGY_HOST_REJECTED', message);
  }
  throw new IntercomError('UNAVAILABLE', message);
}

export async function verifyAgyConversation(context: AgyContext): Promise<string> {
  const response = await request(context, 'GetConversationMetadata', { conversationId: context.conversationId });
  let data: Record<string, unknown> | undefined;
  try { data = asObject(await response.json()); } catch {
    throw new IntercomError('UNAVAILABLE', 'AGY returned unreadable conversation metadata');
  }
  const metadata = asObject(data?.metadata);
  if (!metadata) throw new IntercomError('AGY_CONVERSATION_GONE', 'The AGY conversation no longer exists');
  if (metadata.parentConversationId || metadata.subagentSpec
    || (metadata.rootConversationId && metadata.rootConversationId !== context.conversationId)) {
    throw new IntercomError('AGY_SUBAGENT', 'Subagent conversations cannot join Intercom');
  }
  const rawUri = Array.isArray(metadata.workspaceUris) ? metadata.workspaceUris[0] : undefined;
  const workspace = Array.isArray(metadata.workspaces) ? asObject(metadata.workspaces[0]) : undefined;
  const uri = rawUri ?? workspace?.workspaceFolderAbsoluteUri;
  if (typeof uri === 'string' && uri.startsWith('file://')) {
    try { return fileURLToPath(uri); } catch {}
  }
  return homedir();
}

export async function sendAgyMessage(context: AgyContext, messageId: string, text: string): Promise<void> {
  const response = await request(context, 'SendUserCascadeMessage', {
    cascadeId: context.conversationId,
    items: [{ text }],
    clientMessageId: messageId,
  });
  try {
    if (asObject(await response.json())) return;
  } catch {}
  throw new IntercomError('UNAVAILABLE', 'AGY returned an unreadable message admission response');
}

export function isAgyHostGone(error: unknown): boolean {
  return error instanceof IntercomError
    && ['AGY_HOST_GONE', 'AGY_CONVERSATION_GONE', 'AGY_SUBAGENT'].includes(error.code);
}
