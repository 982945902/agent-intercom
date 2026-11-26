import { z } from 'zod';
import {
  operations, parseInput,
  type ControlSdk, type Input, type Operation, type Results, type SessionSdk,
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
  controlSdk: (ctx: OmpContext) => ControlSdk,
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

  tool('sessionStatus', 'status', 'Show this OMP session’s Intercom ID, alias, group, and presence.',
    ctx => sessionSdk(ctx).sessionStatus());
  tool('listPeers', 'peers', 'List Intercom peers in this session’s current group. Use their session IDs for messaging.',
    ctx => sessionSdk(ctx).listPeers());
  tool('send', 'send', 'Send a message to an Intercom peer in your current group. Use the peer’s session ID as the recipient.',
    (ctx, params) => sessionSdk(ctx).send(params));
  tool('broadcast', 'broadcast', 'Send a message to the other Intercom peers in your current group.',
    (ctx, params) => sessionSdk(ctx).broadcast(params));
  tool('ask', 'ask', 'Ask an Intercom peer in your current group and wait for a reply. Use the peer’s session ID as the recipient.',
    (ctx, params, signal) => sessionSdk(ctx).ask(params, signal));
  tool('reply', 'reply', 'Reply to an Intercom ask. Set replyTo to the explicit message ID of the ask.',
    (ctx, params) => sessionSdk(ctx).reply(params));
  tool('pending', 'pending', 'List incoming Intercom asks that are waiting for your reply.',
    ctx => sessionSdk(ctx).pending());
  tool('listGroups', 'groups', 'List Intercom groups and their members with IDs and membership versions.',
    ctx => controlSdk(ctx).listGroups());
  tool('createGroup', 'create_group', 'Create an Intercom group and assign the specified session IDs to it.',
    (ctx, params) => controlSdk(ctx).createGroup(params));
  tool('moveGroup', 'move_group', 'Move the specified Intercom session IDs to an existing group.',
    (ctx, params) => controlSdk(ctx).moveGroup(params));
}
