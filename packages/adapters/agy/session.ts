import {
  formatIncoming, IntercomError, parseInput,
  type IncomingDelivery, type NativeIdentity, type Results, type SessionSdk,
} from '../../sdk/index.js';
import { openLocalSession, type LocalSession } from '../../sdk/node.js';
import { isAgyHostGone, sendAgyMessage, verifyAgyConversation, type AgyContext } from './host.js';

const agyCommands = ['join', 'list', 'status', 'send', 'ask', 'pending', 'reply', 'broadcast'] as const;
export type AgyCommand = typeof agyCommands[number];
export type AgyResult = Results['join' | 'listPeers' | 'sessionStatus' | 'send' | 'ask' | 'pending' | 'reply' | 'broadcast'];

export function isAgyCommand(command: unknown): command is AgyCommand {
  return typeof command === 'string' && agyCommands.some(candidate => candidate === command);
}

export function parseAgyInput(command: AgyCommand, input: unknown) {
  switch (command) {
    case 'join':
      return input && typeof input === 'object' && 'name' in input && input.name !== undefined
        ? parseInput('rename', input) : {};
    case 'list': return parseInput('listPeers', input);
    case 'status': return parseInput('sessionStatus', input);
    case 'pending': return parseInput('pending', input);
    default: return parseInput(command, input);
  }
}

interface Conversation {
  context: AgyContext;
  identity: NativeIdentity;
  session?: LocalSession;
}

function sameHost(left: AgyContext, right: AgyContext): boolean {
  return left.lsAddress === right.lsAddress && left.csrfToken === right.csrfToken;
}

export class AgySessions {
  private readonly conversations = new Map<string, Conversation>();
  private readonly joins = new Map<string, Promise<Conversation>>();
  private readonly stop = new AbortController();

  constructor(private readonly directory: string) {}

  private remove(entry: Conversation, context: AgyContext): void {
    const id = context.conversationId;
    if (this.conversations.get(id) !== entry || !sameHost(entry.context, context)) return;
    this.conversations.delete(id);
    entry.session?.close();
  }

  private async deliver(entry: Conversation, { message, delivery }: IncomingDelivery, sdk: SessionSdk) {
    const context = entry.context;
    let attempted = false;
    let state: 'host_accepted' | 'rejected' | 'delivery_unknown' = 'host_accepted';
    let failure: unknown;
    try {
      await verifyAgyConversation(context);
      attempted = true;
      await sendAgyMessage(context, message.id, formatIncoming({ message, delivery }));
    } catch (error) {
      failure = error;
      state = !attempted || isAgyHostGone(error) || (error instanceof IntercomError && error.code === 'AGY_HOST_REJECTED')
        ? 'rejected' : 'delivery_unknown';
    }
    try {
      await sdk.receipt({
        deliveryId: delivery.id,
        state,
        source: 'agy',
        detail: failure instanceof IntercomError ? failure.message : undefined,
      });
    } finally {
      if (isAgyHostGone(failure)) this.remove(entry, context);
    }
  }

  private async verify(entry: Conversation, context: AgyContext) {
    const previousContext = entry.context;
    try {
      const cwd = await verifyAgyConversation(context);
      if (entry.context === previousContext) {
        entry.context = context;
        entry.identity.cwd = cwd;
      }
    } catch (error) {
      if (isAgyHostGone(error)) this.remove(entry, context);
      throw error;
    }
  }

  private async bind(context: AgyContext, name?: string): Promise<Conversation> {
    const cwd = await verifyAgyConversation(context);
    const identity: NativeIdentity = {
      adapterKind: 'agy', hostInstanceId: 'antigravity', nativeSessionId: context.conversationId, name, cwd,
    };
    const entry: Conversation = { context, identity };
    entry.session = await openLocalSession(identity, (event, sdk) => this.deliver(entry, event, sdk), {
      directory: this.directory, signal: this.stop.signal,
    });
    if (this.stop.signal.aborted) {
      entry.session.close();
      throw new IntercomError('CANCELLED', 'AGY bridge closed');
    }
    this.conversations.set(context.conversationId, entry);
    return entry;
  }

  async call(command: AgyCommand, input: unknown, context: AgyContext, signal: AbortSignal): Promise<AgyResult> {
    const id = context.conversationId;
    const existing = this.conversations.get(id) ?? this.joins.get(id);
    signal.throwIfAborted();
    if (command === 'join') {
      const args = parseAgyInput(command, input);
      const name = 'name' in args ? args.name : undefined;
      if (existing) {
        const entry = await existing;
        await this.verify(entry, context);
        signal.throwIfAborted();
        const sdk = entry.session!.sdk;
        if (!name) return sdk.sessionStatus();
        const session = await sdk.rename({ name });
        entry.identity.name = session.name;
        return session;
      }
      const opening = this.bind(context, name);
      this.joins.set(id, opening);
      try { return (await opening).session!.sdk.sessionStatus(); } finally { this.joins.delete(id); }
    }
    const joined = await existing;
    if (!joined) throw new IntercomError('NOT_JOINED', 'Run intercom agy join from this AGY conversation first');
    await this.verify(joined, context);
    signal.throwIfAborted();
    const sdk = joined.session!.sdk;
    switch (command) {
      case 'list':
        parseInput('listPeers', input);
        return sdk.listPeers();
      case 'status':
        parseInput('sessionStatus', input);
        return sdk.sessionStatus();
      case 'send': return sdk.send(parseInput('send', input));
      case 'ask': return sdk.ask(parseInput('ask', input), signal);
      case 'pending':
        parseInput('pending', input);
        return sdk.pending();
      case 'reply': return sdk.reply(parseInput('reply', input));
      case 'broadcast': return sdk.broadcast(parseInput('broadcast', input));
    }
  }

  async sweep(): Promise<void> {
    await Promise.all([...this.conversations.values()].map(async entry => {
      const context = entry.context;
      try { await verifyAgyConversation(context); } catch (error) {
        if (isAgyHostGone(error)) this.remove(entry, context);
      }
    }));
  }

  close(): void {
    this.stop.abort();
    this.conversations.clear();
  }
}
