import { setTimeout as delay } from 'node:timers/promises';
import { IntercomError, formatIncoming, type IncomingDelivery, type NativeIdentity, type SessionSdk } from '../../sdk/index.js';
import { createLocalControlSdk, openLocalSession } from '../../sdk/node.js';
import { registerIntercomTools, type OmpTool } from './tools.js';

const statusKey = 'agent-intercom';

type SessionEvent = 'session_start' | 'session_switch' | 'session_shutdown';

interface OmpMessageEvent {
  message: { role: string; attribution?: string; content?: string | { type: string; text?: string }[] };
}

const intercomMessageId = /^\[Intercom (?:peer message|late reply)\] From [^\r\n]+\nMessage ID: ([\da-f-]{36})\n/;

interface OmpContext {
  agent: { kind: 'main' | 'sub' };
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(text: string, kind: 'info' | 'error'): void;
  };
}

interface OmpApi {
  on(event: SessionEvent, handler: (event: unknown, ctx: OmpContext) => void): void;
  on(event: 'message_end', handler: (event: OmpMessageEvent, ctx: OmpContext) => void): void;
  registerTool(tool: OmpTool): void;
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: OmpContext): Promise<void>;
  }): void;
  sendUserMessage(text: string, options: { attribution: 'agent' }): Promise<void>;
}

interface ActiveSession {
  ctx: OmpContext;
  identity: NativeIdentity;
  stop: AbortController;
  admissions: Map<string, () => void>;
  sdk?: SessionSdk;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function intercomExtension(omp: OmpApi): void {
  let active: ActiveSession | undefined;

  function isCurrent(session: ActiveSession): boolean {
    return active === session && session.ctx.sessionManager.getSessionId() === session.identity.nativeSessionId;
  }

  async function deliver(session: ActiveSession, incoming: IncomingDelivery, sdk: SessionSdk): Promise<void> {
    const receipt = { deliveryId: incoming.delivery.id, source: 'omp' };
    if (!isCurrent(session)) {
      await sdk.receipt({ ...receipt, state: 'rejected', detail: 'The original OMP session is no longer active' });
      return;
    }

    const text = formatIncoming(incoming);
    const admission = Promise.withResolvers<void>();
    session.admissions.set(incoming.message.id, admission.resolve);
    try {
      // An idle send can await the whole model turn. The matching native message event confirms admission sooner.
      await Promise.race([omp.sendUserMessage(text, { attribution: 'agent' }), admission.promise]);
    } catch (error) {
      const state = error instanceof Error && error.name === 'PromptDroppedError' ? 'rejected' : 'delivery_unknown';
      await sdk.receipt({ ...receipt, state, detail: errorText(error).slice(0, 1024) });
      return;
    } finally {
      session.admissions.delete(incoming.message.id);
    }
    await sdk.receipt({ ...receipt, state: 'host_accepted' });
  }

  async function connect(session: ActiveSession): Promise<void> {
    const { signal } = session.stop;
    while (!signal.aborted) {
      try {
        const local = await openLocalSession(session.identity, async (incoming, sdk) => {
          // OMP can wait for the entire turn. Let later deliveries reach its steering queue while it runs.
          void deliver(session, incoming, sdk).catch(error => {
            if (isCurrent(session)) session.ctx.ui.notify(`Intercom receipt: ${errorText(error)}`, 'error');
          });
        }, { signal });
        if (isCurrent(session)) {
          session.sdk = local.sdk;
          session.ctx.ui.setStatus(statusKey, undefined);
        }
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof IntercomError) || error.code !== 'UNAVAILABLE') throw error;
      }
      await delay(500, undefined, { signal, ref: false });
    }
  }

  function stopSession(): void {
    const previous = active;
    active = undefined;
    previous?.stop.abort();
    previous?.ctx.ui.setStatus(statusKey, undefined);
  }

  function startSession(ctx: OmpContext): void {
    if (ctx.agent.kind !== 'main') return;
    const nativeSessionId = ctx.sessionManager.getSessionId();
    if (active && active.identity.nativeSessionId === nativeSessionId) {
      active.ctx = ctx;
      return;
    }
    stopSession();
    if (!nativeSessionId) return;

    // The local namespace keeps a resumed transcript's native identity stable.
    const identity: NativeIdentity = { adapterKind: 'omp', hostInstanceId: 'local', nativeSessionId, cwd: ctx.cwd };
    const session: ActiveSession = { ctx, identity, stop: new AbortController(), admissions: new Map() };
    active = session;
    ctx.ui.setStatus(statusKey, 'Intercom connecting');
    void connect(session).catch(error => {
      if (isCurrent(session)) session.ctx.ui.setStatus(statusKey, `Intercom: ${errorText(error)}`);
    });
  }

  function sessionSdk(ctx: OmpContext): SessionSdk {
    if (!active || !isCurrent(active) || active.identity.nativeSessionId !== ctx.sessionManager.getSessionId()) {
      throw new Error('Intercom is unavailable for this OMP session');
    }
    if (!active.sdk) throw new Error('Intercom is connecting');
    return active.sdk;
  }

  omp.on('session_start', (_event, ctx) => startSession(ctx));
  omp.on('session_switch', (_event, ctx) => startSession(ctx));
  omp.on('session_shutdown', (_event, ctx) => {
    if (active?.identity.nativeSessionId === ctx.sessionManager.getSessionId()) stopSession();
  });
  omp.on('message_end', ({ message }, ctx) => {
    if (!active || ctx.sessionManager.getSessionId() !== active.identity.nativeSessionId) return;
    if (message.role !== 'user' || message.attribution !== 'agent') return;
    const { content } = message;
    const text = typeof content === 'string' ? content : content?.find(part => part.type === 'text')?.text;
    const messageId = text?.match(intercomMessageId)?.[1];
    if (messageId) active.admissions.get(messageId)?.();
  });

  const aliasCommand = {
    description: 'Edit this session’s Intercom alias. Usage: /intercom-id [name]',
    async handler(args: string, ctx: OmpContext) {
      try {
        const sdk = sessionSdk(ctx);
        const session = active!;
        let name = args.trim();
        if (!name) {
          const presence = await sdk.sessionStatus();
          if (!isCurrent(session)) return;
          if (!ctx.hasUI) {
            ctx.ui.notify(`Intercom alias: ${presence.name} · group: ${presence.groupId} · ${presence.online ? 'online' : 'offline'} · ID: ${presence.id}`, 'info');
            return;
          }
          const entered = await ctx.ui.input('Set Intercom alias', `Current alias: ${presence.name}`);
          if (entered === undefined || !isCurrent(session)) return;
          name = entered.trim();
          if (!name) {
            ctx.ui.notify('Intercom alias cannot be empty', 'error');
            return;
          }
        }
        const presence = await sdk.rename({ name });
        if (isCurrent(session)) {
          ctx.ui.notify(`Intercom alias: ${presence.name} · group: ${presence.groupId} · ${presence.online ? 'online' : 'offline'}`, 'info');
        }
      } catch (error) {
        ctx.ui.notify(errorText(error), 'error');
      }
    },
  };
  omp.registerCommand('intercom-id', aliasCommand);
  omp.registerCommand('intercom-alias', aliasCommand);

  registerIntercomTools(tool => omp.registerTool(tool), sessionSdk, ctx => {
    sessionSdk(ctx);
    return createLocalControlSdk();
  });
}

export type { OmpContext };
