import { z } from 'zod';
import {
  operations, parseInput,
  type Input, type Operation, type Results, type SessionSdk,
} from '../../sdk/index.js';
import type { OmpContext } from './index.js';

export interface OmpTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: OmpContext,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
}

export function registerIntercomTools(
  register: (tool: OmpTool) => void,
  sessionSdk: (ctx: OmpContext) => SessionSdk,
): void {
  function tool<K extends Operation>(
    operation: K,
    name: string,
    description: string,
    call: (ctx: OmpContext, params: Input<K>, signal?: AbortSignal) => Promise<Results[K]>,
  ): void {
    const { $schema: _, ...parameters } = z.toJSONSchema(operations[operation], { io: 'input' });
    register({
      name: `intercom_${name}`,
      label: `Intercom ${name.replaceAll('_', ' ')}`,
      description,
      parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const result = await call(ctx, parseInput(operation, params) as Input<K>, signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  tool('sessionStatus', 'status', 'Show this OMP session’s Intercom ID, alias, groups, and presence.',
    ctx => sessionSdk(ctx).sessionStatus());
  tool('listPeers', 'peers', 'List online peers, their shared groups, and available system services. Use peer IDs for messaging.',
    ctx => sessionSdk(ctx).listPeers());
  tool('send', 'send', 'Send to a visible peer by ID. Specify groupId when you share more than one group.',
    (ctx, params) => sessionSdk(ctx).send(params));
  tool('broadcast', 'broadcast', 'Broadcast within one business group. Specify groupId if you belong to several.',
    (ctx, params) => sessionSdk(ctx).broadcast(params));
  tool('ask', 'ask', 'Ask a visible peer by ID and wait for a reply. Specify groupId when you share more than one group.',
    (ctx, params, signal) => sessionSdk(ctx).ask(params, signal));
  tool('reply', 'reply', 'Reply to an Intercom ask. Set replyTo to the explicit message ID of the ask.',
    (ctx, params) => sessionSdk(ctx).reply(params));
  tool('pending', 'pending', 'List incoming Intercom asks that are waiting for your reply.',
    ctx => sessionSdk(ctx).pending());
  tool('myGroups', 'groups', 'List the groups that this session belongs to.',
    ctx => sessionSdk(ctx).myGroups());
}
