import { serializeError } from '../../domain/errors.js';
import { newId, type TurnId } from '../../domain/model/ids.js';
import type {
  ContentPart,
  Message,
  MessageAuthor,
  MessageRole,
  ToolCall,
} from '../../domain/model/Message.js';
import type { Session } from '../../domain/model/Session.js';
import type { Turn } from '../../domain/model/Turn.js';
import type { Clock } from '../../ports/Clock.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { Logger } from '../../ports/Logger.js';
import type { ModelRequest } from '../../ports/ModelProvider.js';
import type { Repositories, Transaction } from '../../ports/Repositories.js';
import type { BuiltContext, ContextBuilder } from '../context/ContextBuilder.js';
import type { ModelResponse } from '../modelCalls.js';
import type { ModelRouter } from '../models/ModelRouter.js';
import type { ToolCatalog } from '../tools/ToolCatalog.js';
import { outcomeText, type ToolPipeline } from '../tools/ToolPipeline.js';
import { TurnLock } from '../TurnLock.js';
import { DEFAULT_STEP_LIMITS, StallDetector, type StepLimits } from './limits.js';
import { TurnStopped, type StopController } from './StopController.js';

export interface TurnRunnerDeps {
  agentName: string;
  models: ModelRouter;
  tools: ToolCatalog;
  pipeline: ToolPipeline;
  repos: Repositories;
  clock: Clock;
  log: Logger;
  events: EventBus;
  stops: StopController;
  /** Builds each model call's context: header, history with context notes, tail (F04). */
  context: ContextBuilder;
  limits?: Partial<StepLimits>;
}

/** The end of a turn, as the scheduler and callers see it. */
export type TurnResult =
  { status: 'succeeded'; reply: string } | { status: 'failed' | 'cancelled'; error: string };

/** A turn ended on purpose before an answer: a step limit, a stall, a repeated tool failure. */
class TurnEnded extends Error {}

/**
 * Runs one turn that the scheduler has already moved to `running`: streams the model, runs tools
 * through the pipeline, reads new owner messages before every model call (steering), and stops on
 * Stop, the step limit, or a stall (F04).
 */
export class TurnRunner {
  private readonly turnLock: TurnLock;
  private readonly limits: StepLimits;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.turnLock = new TurnLock(deps.repos);
    this.limits = { ...DEFAULT_STEP_LIMITS, ...deps.limits };
  }

  async run(turn: Turn): Promise<TurnResult> {
    const { repos, clock, events, log, stops } = this.deps;
    const session = await repos.sessions.get(turn.sessionId);
    if (!session) throw new Error(`Session ${turn.sessionId} not found`);
    const base = {
      turnId: turn.id,
      sessionId: session.id,
      replyChannel: turn.toProps().replyChannel,
    };
    const signal = stops.begin(turn.id);
    events.publish('turn.status', { ...base, status: 'running' });

    try {
      const reply = await this.loop(session, turn, signal);
      if (!(await this.save(turn, 'running', () => turn.succeed(clock.now())))) {
        const error = 'The turn was ended elsewhere before it finished';
        events.publish('turn.status', { ...base, status: 'failed', error });
        return { status: 'failed', error };
      }
      events.publish('turn.status', { ...base, status: 'succeeded', reply });
      return { status: 'succeeded', reply };
    } catch (error) {
      if (signal.aborted) {
        const reason = signal.reason instanceof TurnStopped ? signal.reason.message : 'stopped';
        await repos.uow.run(async (tx) => {
          turn.cancel(clock.now(), reason);
          await repos.turns.update(turn, 'running', tx);
          // The request is withdrawn: the agent continues only if asked again (F04).
          await repos.messages.withdrawByTurn(turn.id, tx);
        });
        events.publish('turn.status', { ...base, status: 'cancelled', error: reason });
        return { status: 'cancelled', error: reason };
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (!(error instanceof TurnEnded)) {
        log.error('Turn failed', { turnId: turn.id, error: serializeError(error) });
      }
      await this.save(turn, 'running', () => turn.fail(clock.now(), reason));
      events.publish('turn.status', { ...base, status: 'failed', error: reason });
      return { status: 'failed', error: reason };
    } finally {
      stops.end(turn.id);
    }
  }

  private async loop(session: Session, turn: Turn, signal: AbortSignal): Promise<string> {
    const max = this.limits[session.kind];
    const stall = new StallDetector();
    for (let step = 1; step <= max; step++) {
      signal.throwIfAborted();
      if (step > 1) await this.assertStillRunning(turn);
      // Reloading the history each step is what steering means: owner messages that arrived during
      // the turn are stored with its id and appear here before the next model call.
      const context = await this.deps.context.build(session, turn);
      const response = await this.callModel(session, turn, context, signal);
      const parts: ContentPart[] = [];
      // Reasoning is kept in the transcript but never shown as the reply or sent back (F03).
      if (response.reasoning) parts.push({ type: 'reasoning', text: response.reasoning });
      if (response.text) parts.push({ type: 'text', text: response.text });
      for (const call of response.toolCalls) parts.push({ type: 'tool_call', call });
      await this.store(session, turn.id, 'assistant', 'assistant', parts);

      if (!response.toolCalls.length) {
        // A message steered in after this model call was sent would otherwise go unanswered.
        if (await this.hasSteeredMessage(session, turn, context.sources)) continue;
        this.deps.events.publish('message.sent', {
          sessionId: session.id,
          role: 'assistant',
          content: response.text,
        });
        return response.text;
      }
      const results: { isError: boolean }[] = [];
      for (const call of response.toolCalls) {
        const result = await this.executeTool(session, turn, call, signal);
        results.push(result);
        await this.store(session, turn.id, 'tool', 'system', [
          {
            type: 'tool_result',
            toolCallId: call.id,
            content: result.content,
            isError: result.isError,
          },
        ]);
      }
      const stalled = stall.record(results);
      if (stalled) throw new TurnEnded(stalled);
    }
    throw new TurnEnded(
      `Stopped after ${max} model calls without a final answer (step limit for ${session.kind} sessions)`,
    );
  }

  /** An owner message steered into this turn after the last model call was sent. */
  private async hasSteeredMessage(session: Session, turn: Turn, sent: Message[]): Promise<boolean> {
    const seen = new Set(sent.map((m) => m.id));
    const latest = await this.deps.repos.messages.listBySession(session.id, { limit: 10 });
    return latest.some(
      (m) => m.author === 'owner' && m.turnId === turn.id && !m.withdrawn && !seen.has(m.id),
    );
  }

  /**
   * A turn ended elsewhere (recovery after a crash, another process's Stop) must not keep running here:
   * it would spend tokens and write into a conversation that has moved on.
   */
  private async assertStillRunning(turn: Turn): Promise<void> {
    const stored = await this.deps.repos.turns.get(turn.id);
    if (stored?.status !== 'running') {
      throw new TurnEnded(`The turn was ended elsewhere (now ${stored?.status ?? 'missing'})`);
    }
  }

  private async callModel(
    session: Session,
    turn: Turn,
    context: BuiltContext,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const { events, repos, clock, models, agentName } = this.deps;
    const request: Omit<ModelRequest, 'model'> = {
      ...(context.system && { system: context.system }),
      messages: context.messages,
      tools: this.deps.tools.specs(),
      temperature: 0.7,
      maxOutputTokens: 4096,
      metadata: { turnId: turn.id },
    };
    if (!request.tools?.length) delete request.tools;
    events.publish('llm.request', {
      agentId: agentName,
      sessionId: session.id,
      model: models.select('chat').ref,
    });
    try {
      const { response, binding } = await models.complete('chat', request, {
        signal,
        onEvent: (e) => {
          if (e.type === 'text_delta') {
            events.publish('turn.text_delta', {
              turnId: turn.id,
              sessionId: session.id,
              text: e.text,
            });
          }
        },
      });
      events.publish('llm.response', {
        agentId: agentName,
        sessionId: session.id,
        contentLength: response.text.length,
        hasToolCalls: response.toolCalls.length > 0,
      });
      await repos.turnEvents.append({
        turnId: turn.id,
        kind: 'model_call',
        data: { model: binding.ref, usage: response.usage, finishReason: response.finishReason },
        at: clock.now(),
      });
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      events.publish('llm.error', {
        agentId: agentName,
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
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const { events, log } = this.deps;
    const meta = {
      turnId: turn.id,
      sessionId: session.id,
      toolName: call.name,
      toolCallId: call.id,
    };
    events.publish('tool.started', meta);
    events.publish('tool.called', meta);
    const outcome = await this.deps.pipeline.execute(call, {
      turnId: turn.id,
      sessionId: session.id,
      signal,
      log: log.child({ tool: call.name }),
      events,
      writeFenced: (fn) => this.turnLock.write(turn.id, fn),
    });
    signal.throwIfAborted();
    const ok = outcome.kind === 'ok';
    events.publish('tool.finished', { ...meta, ok, ...(!ok && { error: outcome.content }) });
    if (ok) events.publish('tool.result', { ...meta, success: true });
    else events.publish('tool.error', { ...meta, error: outcome.content });
    if (outcome.kind === 'error' && outcome.reason === 'repeated_failure') {
      throw new TurnEnded(outcome.content); // ends the turn instead of looping (F05)
    }
    return { content: outcomeText(outcome), isError: !ok };
  }

  private async store(
    session: Session,
    turnId: TurnId,
    role: MessageRole,
    author: MessageAuthor,
    parts: ContentPart[],
    tx?: Transaction,
  ): Promise<void> {
    await this.deps.repos.messages.append(
      {
        id: newId(),
        threadId: session.threadId,
        sessionId: session.id,
        turnId,
        role,
        author,
        parts,
        withdrawn: false,
        createdAt: this.deps.clock.now(),
      },
      tx,
    );
  }

  /** Applies a transition and saves it only if no one else moved the turn in the meantime. */
  private async save(turn: Turn, expected: Turn['status'], apply: () => void): Promise<boolean> {
    apply();
    const saved = await this.deps.repos.turns.update(turn, expected);
    if (!saved) this.deps.log.warn('Turn was changed elsewhere', { turnId: turn.id, expected });
    return saved;
  }
}
