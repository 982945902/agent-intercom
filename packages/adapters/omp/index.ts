import { setTimeout as delay } from 'node:timers/promises';
import { IntercomError, formatIncoming, type IncomingDelivery, type NativeIdentity, type SessionSdk } from '../../sdk/index.js';
import { createLocalControlSdk, openLocalSession } from '../../sdk/node.js';
import { registerIntercomTools, type OmpTool } from './tools.js';

const statusKey = 'agent-intercom';

type SessionEvent = 'session_start' | 'session_switch' | 'session_shutdown';

interface OmpContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(text: string, kind: 'info' | 'error'): void;
  };
}

interface OmpApi {
  on(event: SessionEvent, handler: (event: unknown, ctx: OmpContext) => void): void;
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

    try {
      // OMP's default user-message path starts an idle turn and atomically steers a streaming turn.
      await omp.sendUserMessage(formatIncoming(incoming), { attribution: 'agent' });
    } catch (error) {
      const state = error instanceof Error && error.name === 'PromptDroppedError' ? 'rejected' : 'delivery_unknown';
      await sdk.receipt({ ...receipt, state, detail: errorText(error).slice(0, 1024) });
      return;
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
    const nativeSessionId = ctx.sessionManager.getSessionId();
    if (active && active.identity.nativeSessionId === nativeSessionId) {
      active.ctx = ctx;
      return;
    }
    stopSession();
    if (!nativeSessionId) return;

    // The local namespace keeps a resumed transcript's native identity stable.
    const identity: NativeIdentity = { adapterKind: 'omp', hostInstanceId: 'local', nativeSessionId, cwd: ctx.cwd };
    const session: ActiveSession = { ctx, identity, stop: new AbortController() };
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

  omp.registerCommand('intercom-alias', {
    description: 'Show or change this session’s Intercom alias. Usage: /intercom-alias [name]',
    async handler(args, ctx) {
      try {
        const sdk = sessionSdk(ctx);
        const session = active;
        const name = args.trim();
        const presence = name ? await sdk.rename({ name }) : await sdk.sessionStatus();
        if (session && isCurrent(session)) {
          ctx.ui.notify(`Intercom alias: ${presence.name} · group: ${presence.groupId} · ${presence.online ? 'online' : 'offline'}`, 'info');
        }
      } catch (error) {
        ctx.ui.notify(errorText(error), 'error');
      }
    },
  });

  registerIntercomTools(tool => omp.registerTool(tool), sessionSdk, ctx => {
    sessionSdk(ctx);
    return createLocalControlSdk();
  });
}

export type { OmpContext };
