import { serializeError } from '../domain/errors.js';
import { newId, type OwnerId, type SessionId, type TurnId } from '../domain/model/ids.js';
import {
  textOf,
  toolCallsOf,
  type ContentPart,
  type Message,
  type MessageAuthor,
  type MessageRole,
  type ToolCall,
} from '../domain/model/Message.js';
import { Session, type SessionKind } from '../domain/model/Session.js';
import type { Thread } from '../domain/model/Thread.js';
import { Turn, type TurnSource } from '../domain/model/Turn.js';
import type { Clock } from '../ports/Clock.js';
import type { AgentRenderContext, ContextInjectable } from '../ports/ContextInjectable.js';
import type { EventBus } from '../ports/EventBus.js';
import type { ModelMessage, ModelProvider, ModelRequest } from '../ports/ModelProvider.js';
import type { Logger } from '../ports/Logger.js';
import type { Repositories, Transaction } from '../ports/Repositories.js';
import type { Tool } from '../ports/Tool.js';
import { IdentityInjectable, RulesInjectable, ToolListInjectable } from './context/index.js';
import { complete, type ModelResponse } from './modelCalls.js';
import { ToolRegistry } from './ToolRegistry.js';

export interface AgentOptions {
  name: string;
  ownerId: OwnerId;
  llmProvider: ModelProvider;
  /** The provider's model name, e.g. "deepseek-v4.1-flash". */
  model: string;
  repos: Repositories;
  clock: Clock;
  log: Logger;
  events: EventBus;
  /** How many recent messages are sent to the model. */
  historyLimit?: number;
  /** Model calls per turn before the turn is stopped (a runaway tool loop). */
  maxSteps?: number;
}

export interface SendOptions {
  /** Defaults to the owner's main chat session. */
  sessionId?: SessionId;
  /** The channel the message came in on, e.g. "cli". */
  channel?: string;
  source?: TurnSource;
}

export interface SendResult {
  reply: string;
  sessionId: SessionId;
  turnId: TurnId;
}

/** A turn stopped because it used up its steps. */
export class StepLimitReached extends Error {
  override readonly name = 'StepLimitReached';
}

/**
 * Today's agent loop on the new domain model: each message becomes a stored Turn that runs through the
 * state machine, and every message is stored with content parts. Replaced by the TurnRunner in F04.
 */
export class Agent {
  readonly name: string;
  private readonly options: Required<AgentOptions>;
  private readonly toolRegistry: ToolRegistry;
  private injectables: ContextInjectable[] = [];

  constructor(options: AgentOptions) {
    this.options = { historyLimit: 40, maxSteps: 40, ...options };
    this.name = options.name;
    this.toolRegistry = new ToolRegistry(options.log);
    this.injectables = [
      new IdentityInjectable({ name: this.name, description: 'a helpful AI assistant' }),
      new ToolListInjectable([]),
      new RulesInjectable([
        { id: 'helpful', text: 'Be helpful and concise' },
        { id: 'safe', text: 'Do not reveal sensitive information' },
      ]),
    ];
    this.sortInjectables();
  }

  addInjectable(injectable: ContextInjectable): void {
    this.injectables.push(injectable);
    this.sortInjectables();
  }

  getTools(): Tool[] {
    return this.toolRegistry.list();
  }

  registerTool(tool: Tool): void {
    this.toolRegistry.register(tool);
    this.injectables = this.injectables.filter((i) => i.id !== 'tool-list');
    this.injectables.push(new ToolListInjectable(this.toolRegistry.getToolDefinitions()));
    this.sortInjectables();
  }

  /** Starts a new session in the owner's thread, e.g. a fresh conversation in the TUI. */
  async startSession(kind: SessionKind = 'chat'): Promise<SessionId> {
    const { repos, clock } = this.options;
    return repos.uow.run(async (tx) => {
      const thread = await repos.threads.getOrCreateForOwner(this.options.ownerId, clock.now(), tx);
      return (await this.createSession(thread, kind, tx)).id;
    });
  }

  /** Sends an owner message and runs the agent until it replies. */
  async send(content: string, opts: SendOptions = {}): Promise<SendResult> {
    const { repos, clock, events } = this.options;

    // Store the message and its queued turn together, so neither exists without the other.
    const { session, turn } = await repos.uow.run(async (tx) => {
      const thread = await repos.threads.getOrCreateForOwner(this.options.ownerId, clock.now(), tx);
      const session = await this.resolveSession(thread, opts.sessionId, tx);
      const turn = Turn.create({
        id: newId(),
        sessionId: session.id,
        source: opts.source ?? 'user',
        createdAt: clock.now(),
        replyChannel: opts.channel,
      });
      await repos.turns.insert(turn, tx);
      await this.store(
        session,
        turn.id,
        'user',
        'owner',
        [{ type: 'text', text: content }],
        tx,
        opts.channel,
      );
      return { session, turn };
    });
    events.publish('message.received', { sessionId: session.id, role: 'user', content });

    await this.move(turn, 'queued', () => turn.start(clock.now()));
    try {
      const reply = await this.runLoop(session, turn);
      await this.move(turn, 'running', () => turn.succeed(clock.now()));
      return { reply, sessionId: session.id, turnId: turn.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.move(turn, 'running', () => turn.fail(clock.now(), reason)).catch((e: unknown) =>
        this.options.log.error('Could not mark turn failed', {
          turnId: turn.id,
          error: serializeError(e),
        }),
      );
      throw error;
    }
  }

  private async runLoop(session: Session, turn: Turn): Promise<string> {
    for (let step = 1; step <= this.options.maxSteps; step++) {
      const history = await this.options.repos.messages.listBySession(session.id, {
        limit: this.options.historyLimit,
      });
      const response = await this.callModel(session, turn, history);
      const calls: ToolCall[] = response.toolCalls;
      const parts: ContentPart[] = [];
      // Reasoning is kept in the transcript but never shown as the reply or sent back (F03).
      if (response.reasoning) parts.push({ type: 'reasoning', text: response.reasoning });
      if (response.text) parts.push({ type: 'text', text: response.text });
      for (const call of calls) parts.push({ type: 'tool_call', call });
      await this.store(session, turn.id, 'assistant', 'assistant', parts);

      if (calls.length === 0) {
        this.options.events.publish('message.sent', {
          sessionId: session.id,
          role: 'assistant',
          content: response.text,
        });
        return response.text;
      }
      for (const call of calls) {
        const { content, isError } = await this.executeTool(session, turn, call);
        await this.store(session, turn.id, 'tool', 'system', [
          { type: 'tool_result', toolCallId: call.id, content, isError },
        ]);
      }
    }
    throw new StepLimitReached(
      `Stopped after ${this.options.maxSteps} model calls without a final answer (step limit)`,
    );
  }

  private async callModel(
    session: Session,
    turn: Turn,
    history: Message[],
  ): Promise<ModelResponse> {
    const { events, repos, clock } = this.options;
    const tools = this.toolRegistry.getToolDefinitions();
    const request: ModelRequest = {
      model: this.options.model,
      system: this.buildContext(session, history),
      messages: toModelMessages(trimToWholeExchanges(history)),
      tools: tools.length ? tools : undefined,
      temperature: 0.7,
      maxOutputTokens: 4096,
    };
    events.publish('llm.request', {
      agentId: this.name,
      sessionId: session.id,
      model: request.model,
    });
    try {
      const response = await complete(this.options.llmProvider, request);
      events.publish('llm.response', {
        agentId: this.name,
        sessionId: session.id,
        contentLength: response.text.length,
        hasToolCalls: response.toolCalls.length > 0,
      });
      await repos.turnEvents.append({
        turnId: turn.id,
        kind: 'model_call',
        data: {
          provider: this.options.llmProvider.id,
          model: request.model,
          usage: response.usage,
          finishReason: response.finishReason,
        },
        at: clock.now(),
      });
      return response;
    } catch (error) {
      events.publish('llm.error', {
        agentId: this.name,
        sessionId: session.id,
        error: String(error),
      });
      await repos.turnEvents.append({
        turnId: turn.id,
        kind: 'model_error',
        data: { error: serializeError(error) },
        at: clock.now(),
      });
      throw error;
    }
  }

  private async executeTool(
    session: Session,
    turn: Turn,
    call: ToolCall,
  ): Promise<{ content: string; isError: boolean }> {
    const { events, repos, clock, log } = this.options;
    const meta = { sessionId: session.id, toolName: call.name, toolCallId: call.id };
    events.publish('tool.called', meta);
    await repos.turnEvents.append({
      turnId: turn.id,
      kind: 'tool_start',
      data: { tool: call.name, toolCallId: call.id },
      at: clock.now(),
    });
    log.info('Executing tool', { tool: call.name });

    let content: string;
    let isError: boolean;
    try {
      const result = await this.toolRegistry.execute(call.name, {
        sessionId: session.id,
        args: call.arguments,
      });
      events.publish('tool.result', { ...meta, success: result.success });
      isError = !result.success;
      content = result.success ? result.result : `Error: ${result.error}`;
    } catch (error) {
      events.publish('tool.error', { ...meta, error: String(error) });
      isError = true;
      content = `Error: ${String(error)}`;
    }
    await repos.turnEvents.append({
      turnId: turn.id,
      kind: 'tool_end',
      data: { tool: call.name, toolCallId: call.id, isError },
      at: clock.now(),
    });
    return { content, isError };
  }

  private buildContext(session: Session, messages: Message[]): string {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const ctx: AgentRenderContext = {
      session,
      messages,
      toolCalls: lastAssistant ? toolCallsOf(lastAssistant) : [],
      lastUserMessage: lastUser ? textOf(lastUser) : undefined,
    };
    return this.injectables
      .filter((i) => this.applies(i, ctx))
      .map((i) => i.render(ctx))
      .filter((s): s is string => s !== null)
      .join('\n\n');
  }

  private applies(injectable: ContextInjectable, ctx: AgentRenderContext): boolean {
    const condition = injectable.condition;
    switch (condition.type) {
      case 'always':
        return true;
      case 'tool_used': {
        const used = (ctx.toolCalls ?? []).map((c) => c.name);
        return condition.toolNames.length === 0
          ? used.length > 0
          : used.some((n) => condition.toolNames.includes(n));
      }
      case 'pattern_detected':
        return (
          !!ctx.lastUserMessage && condition.patterns.some((p) => p.test(ctx.lastUserMessage!))
        );
      case 'custom':
        return condition.check(ctx);
      case 'once':
        return false; // per-session tracking arrives with F04 (bug 8)
    }
  }

  private async resolveSession(thread: Thread, id: SessionId | undefined, tx: Transaction) {
    const { repos } = this.options;
    if (id) {
      const session = await repos.sessions.get(id, tx);
      if (!session || session.threadId !== thread.id) throw new Error(`Session ${id} not found`);
      return session;
    }
    return (
      (await repos.sessions.findMainChat(thread.id, tx)) ?? this.createSession(thread, 'chat', tx)
    );
  }

  private async createSession(
    thread: Thread,
    kind: SessionKind,
    tx: Transaction,
  ): Promise<Session> {
    const session = new Session(newId(), thread.id, kind, this.options.clock.now());
    await this.options.repos.sessions.insert(session, tx);
    this.options.events.publish('session.created', { sessionId: session.id, agentId: this.name });
    return session;
  }

  private async store(
    session: Session,
    turnId: TurnId,
    role: MessageRole,
    author: MessageAuthor,
    parts: ContentPart[],
    tx?: Transaction,
    channel?: string,
  ): Promise<void> {
    await this.options.repos.messages.append(
      {
        id: newId(),
        threadId: session.threadId,
        sessionId: session.id,
        turnId,
        role,
        author,
        parts,
        channel,
        withdrawn: false,
        createdAt: this.options.clock.now(),
      },
      tx,
    );
  }

  /** Applies a turn transition and saves it only if no one else moved the turn in the meantime. */
  private async move(turn: Turn, expected: Turn['status'], apply: () => void): Promise<void> {
    apply();
    const saved = await this.options.repos.turns.update(turn, expected);
    if (!saved)
      throw new Error(`Turn ${turn.id} was changed by someone else (expected ${expected})`);
  }

  private sortInjectables(): void {
    this.injectables.sort((a, b) => b.priority - a.priority);
  }
}

/**
 * Drops messages from the start of a window until it begins with a user message, so a tool result is
 * never sent without the call that produced it (part of bug 2).
 */
function trimToWholeExchanges(messages: Message[]): Message[] {
  const first = messages.findIndex((m) => m.role === 'user');
  return first === -1 ? messages : messages.slice(first);
}

/** Stored messages → model messages: content parts pass through; withdrawn messages are left out. */
function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.filter((m) => !m.withdrawn).map((m) => ({ role: m.role, parts: m.parts }));
}
