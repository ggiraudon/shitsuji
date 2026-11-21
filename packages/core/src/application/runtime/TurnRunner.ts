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
import type { ModelMessage, ModelRequest } from '../../ports/ModelProvider.js';
import type { Repositories, Transaction } from '../../ports/Repositories.js';
import type { BuiltContext, ContextBuilder } from '../context/ContextBuilder.js';
import type { ModelResponse } from '../modelCalls.js';
import type { ModelRouter } from '../models/ModelRouter.js';
import type { BudgetService } from '../budget/BudgetService.js';
import type { SoulSource } from '../soul/SoulService.js';
import type { ToolCatalog } from '../tools/ToolCatalog.js';
import { outcomeText, type ToolPipeline } from '../tools/ToolPipeline.js';
import type { OutboundFile, ToolImage } from '../../ports/Tool.js';
import { outboundFiles } from '../../ports/Tool.js';
import { TurnLock } from '../TurnLock.js';
import { DEFAULT_STEP_LIMITS, StallDetector, type StepLimits } from './limits.js';
import { TurnStopped, type StopController } from './StopController.js';

/** Everything one runner needs; `Agent` builds it once and shares it across turns. */
export interface TurnRunnerDeps {
  /** The agent's name, used as `agentId` on model events. */
  agentName: string;
  /** The router that picks and calls the chat model by purpose. */
  models: ModelRouter;
  /** The live catalog whose specs go to the model and whose extra tools are reachable. */
  tools: ToolCatalog;
  /** The one path a tool call takes: validation, trust, receipts, execution. */
  pipeline: ToolPipeline;
  /** Turn, message and turn-event storage, plus the unit of work for compare-and-set writes. */
  repos: Repositories;
  /** Injected clock for every timestamp this turn writes. */
  clock: Clock;
  /** Structured logger; a failed turn is reported here unless it was a deliberate ending. */
  log: Logger;
  /** The bus for `turn.status`, deltas, model and tool events. */
  events: EventBus;
  /** The in-process stop registry; `begin` returns this turn's abort signal. */
  stops: StopController;
  /** Builds each model call's context: header, history with context notes, tail (F04). */
  context: ContextBuilder;
  /** The SOUL this turn runs with; absent in tests that do not care. */
  soul?: SoulSource;
  /** Checks the check-in limit; absent when the run has no budget (unit tests). */
  budget?: BudgetService;
  /** Overrides for the per-session-kind step limits. */
  limits?: Partial<StepLimits>;
}

/** The end of a turn, as the scheduler and callers see it. */
export type TurnResult =
  /** The model produced a final answer; `files` are the outbound files the tools staged. */
  | {
      /** The turn ended with an answer. */
      status: 'succeeded';
      /** The assistant's text. */
      reply: string;
      /** Files tools attached to the reply, when there are any. */
      files?: OutboundFile[];
    }
  /** The check-in limit asked the owner a question; the next message resumes the session. */
  | {
      /** The turn paused with a question. */
      status: 'waiting';
      /** The question that was stored as the reply. */
      question: string;
    }
  /** The turn ended without an answer; `error` is also stored on the turn row. */
  | {
      /** The turn failed, or was stopped by its abort signal. */
      status: 'failed' | 'cancelled';
      /** The reason stored on the row and published with the terminal event. */
      error: string;
    };

/** One pass of the loop: an answer, or a question when the check-in limit is passed. */
type LoopOutcome =
  { kind: 'reply'; text: string; files: OutboundFile[] } | { kind: 'question'; text: string };

/**
 * A turn ended on purpose before an answer: a step limit, a stall, a repeated tool failure, or the
 * turn being ended elsewhere. It is not a bug, so the runner does not log it as an error; its message
 * becomes the turn's `error` and the failed event's text.
 */
class TurnEnded extends Error {}

/**
 * Runs **one** turn that the scheduler has already moved to `running` (F04): publishes `running`,
 * fixes the SOUL revision, then loops over context → budget check-in → model → tools until an answer,
 * a question, a stop, a stall or the step limit. It reloads the turn before every step after the
 * first, so a turn cancelled by another process or by recovery stops instead of spending more; every
 * state change is saved with compare-and-set.
 *
 * Side effects: model calls (through `ModelRouter`), tool calls (through `ToolPipeline`, whose writes
 * are fenced by `TurnLock`), message rows for the assistant and tool results, `turn_event` rows for
 * model calls and errors, and one terminal `turn.status` event. Event publishes are synchronous and
 * are not awaited; the model provider call and every database write are awaited in order.
 *
 * ```mermaid
 * flowchart TD
 *   start([run: publish running]) --> build[build context from storage]
 *   build --> checkin{check-in limit passed?}
 *   checkin -- yes --> waiting([waiting + question, stored])
 *   checkin -- no --> model[model complete chat]
 *   model --> store[store assistant parts]
 *   store --> calls{any tool calls?}
 *   calls -- no --> steered{a steered message arrived?}
 *   steered -- yes --> build
 *   steered -- no --> reply([succeeded + reply])
 *   calls -- yes --> tools[run each tool through the pipeline, store results]
 *   tools --> stall{stalled?}
 *   stall -- yes --> failed([failed: TurnEnded])
 *   stall -- no --> more{steps left?}
 *   more -- yes --> build
 *   more -- no --> failed
 * ```
 *
 * Concurrency: the scheduler may run turns for different sessions in parallel, but only one turn per
 * session, and only after a compare-and-set start. This class assumes it owns the turn it is given;
 * it is not safe to call `run` twice for the same turn.
 */
export class TurnRunner {
  /** Fences tool writes with the turn's row lock (a stopped turn cannot write late). */
  private readonly turnLock: TurnLock;
  /** Per-session-kind model-call limits, merged with the defaults. */
  private readonly limits: StepLimits;

  /**
   * Builds the lock and merges the step limits. No I/O; the runner is created once by `Agent` and
   * reused for every turn.
   */
  constructor(
    /** Everything one runner needs; `Agent` passes the same object to every turn. */
    private readonly deps: TurnRunnerDeps,
  ) {
    this.turnLock = new TurnLock(deps.repos);
    this.limits = { ...DEFAULT_STEP_LIMITS, ...deps.limits };
  }

  /**
   * Runs the turn to a terminal state. Called exactly once by `TurnScheduler.drain` after the
   * turn's compare-and-set start; it assumes `running` and never resumes a `waiting` turn.
   *
   * Order: load the session (a missing session throws, and the scheduler logs the crash), register
   * the abort signal, publish `running`, resolve the SOUL revision (fixed for the turn), run the
   * step loop, then persist one of `succeeded`, `waiting`, `failed` or `cancelled` and publish it.
   * A Stop aborts the signal; the catch path cancels the turn, withdraws the messages it produced
   * and publishes `cancelled`. A deliberate ending (`TurnEnded`) is stored as `failed` without an
   * error log; any other error is logged and also stored as `failed`. The `finally` removes the
   * abort signal from `StopController` whenever the loop was entered, including on a thrown error.
   *
   * Every terminal write is a compare-and-set from `running`. If it loses (another process or
   * startup recovery already ended the turn), nothing is withdrawn, no terminal event is published
   * and no failure is logged: the stored turn and its event stand, and this runner returns a result
   * that only describes what it would have done.
   */
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
      // The SOUL is fixed when the turn starts: a revision confirmed mid-turn waits for the next one.
      const soul = this.deps.soul ? await this.deps.soul.current(session.kind) : undefined;
      if (soul) turn.useSoul(soul.revision);
      const outcome = await this.loop(session, turn, signal, soul);
      if (outcome.kind === 'question') {
        if (!(await this.pause(turn, session, outcome.text))) {
          // Another process ended the turn first: leave its state and event alone.
          return { status: 'failed', error: 'The turn was ended elsewhere before it could ask' };
        }
        events.publish('turn.status', { ...base, status: 'waiting', question: outcome.text });
        return { status: 'waiting', question: outcome.text };
      }
      const reply = outcome.text;
      const files = outcome.files;
      if (!(await this.save(turn, 'running', () => turn.succeed(clock.now())))) {
        // Another process ended the turn first: its terminal state and event already stand.
        return { status: 'failed', error: 'The turn was ended elsewhere before it finished' };
      }
      events.publish('turn.status', {
        ...base,
        status: 'succeeded',
        reply,
        ...(files.length > 0 && { files }),
      });
      return { status: 'succeeded', reply, ...(files.length > 0 && { files }) };
    } catch (error) {
      if (signal.aborted) {
        const reason = signal.reason instanceof TurnStopped ? signal.reason.message : 'stopped';
        const cancelled = await repos.uow.run(async (tx) => {
          turn.cancel(clock.now(), reason);
          // A Stop that lost the race with another process must not withdraw that process's
          // messages or report a second terminal state.
          if (!(await repos.turns.update(turn, 'running', tx))) return false;
          // The request is withdrawn: the agent continues only if asked again (F04).
          await repos.messages.withdrawByTurn(turn.id, tx);
          return true;
        });
        if (cancelled) {
          events.publish('turn.status', { ...base, status: 'cancelled', error: reason });
        }
        return { status: 'cancelled', error: reason };
      }
      const reason = error instanceof Error ? error.message : String(error);
      const saved = await this.save(turn, 'running', () => turn.fail(clock.now(), reason));
      if (saved) {
        if (!(error instanceof TurnEnded)) {
          log.error('Turn failed', { turnId: turn.id, error: serializeError(error) });
        }
        events.publish('turn.status', { ...base, status: 'failed', error: reason });
      }
      return { status: 'failed', error: reason };
    } finally {
      stops.end(turn.id);
    }
  }

  /**
   * The step loop. For each step it:
   *
   * 1. throws at once if the signal is already aborted;
   * 2. after the first step, reloads the turn and stops if it is no longer `running` (another
   *    process or recovery ended it);
   * 3. rebuilds the context from storage — this is how steering works, because a message stored
   *    with the turn's id appears here before the next model call;
   * 4. asks `askBeforeContinuing` before spending a model call;
   * 5. calls the model, stores its content parts, and either answers (no tool calls) or runs the
   *    tool calls one at a time, storing each result and feeding the stall detector.
   *
   * A steered message that arrives after the model request was sent is detected after the response
   * and costs one more step rather than being dropped. The loop is bounded by the session kind's
   * model-call limit; exceeding it throws `TurnEnded` with a message naming the limit. Tools run
   * sequentially in the model's order; their files accumulate in the reply.
   */
  private async loop(
    session: Session,
    turn: Turn,
    signal: AbortSignal,
    soul?: { revision: number; body: string },
  ): Promise<LoopOutcome> {
    const max = this.limits[session.kind];
    const stall = new StallDetector();
    const files: OutboundFile[] = [];
    for (let step = 1; step <= max; step++) {
      signal.throwIfAborted();
      if (step > 1) await this.assertStillRunning(turn);
      // Reloading the history each step is what steering means: owner messages that arrived during
      // the turn are stored with its id and appear here before the next model call.
      const context = await this.deps.context.build(session, turn, soul, signal);
      // Past the check-in amount, ask before spending more (S28). Doing it before the call means the
      // question itself costs nothing.
      const question = await this.askBeforeContinuing(session, context);
      if (question) return { kind: 'question', text: question };
      const response = await this.callModel(session, turn, context, signal);
      const parts: ContentPart[] = [];
      // Reasoning is kept in the transcript but never shown as the reply or sent back (F03).
      if (response.reasoning) parts.push({ type: 'reasoning', text: response.reasoning });
      if (response.text) parts.push({ type: 'text', text: response.text });
      for (const call of response.toolCalls) parts.push({ type: 'tool_call', call });
      await this.store(session, turn.id, 'assistant', 'assistant', parts);

      if (!response.toolCalls.length) {
        // A message steered in after this model call was sent would otherwise go unanswered.
        if (await this.hasSteeredMessage(turn, context.sources)) continue;
        this.deps.events.publish('message.sent', {
          sessionId: session.id,
          role: 'assistant',
          content: response.text,
        });
        return { kind: 'reply', text: response.text, files };
      }
      const results: { isError: boolean }[] = [];
      for (const call of response.toolCalls) {
        const result = await this.executeTool(session, turn, call, signal);
        results.push(result);
        files.push(...result.files);
        await this.store(session, turn.id, 'tool', 'system', [
          {
            type: 'tool_result',
            toolCallId: call.id,
            content: result.content,
            isError: result.isError,
            ...(result.images?.length && { images: result.images }),
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

  /**
   * The question to ask before carrying on, when this session has spent past the check-in amount
   * since the owner's last message. Checked before a model call, so the question costs nothing.
   * A run without a budget (unit tests) never asks. Side effects: one budget read; the question is
   * not stored here (the caller pauses the turn, which stores it).
   */
  private async askBeforeContinuing(
    session: Session,
    context: BuiltContext,
  ): Promise<string | undefined> {
    if (!this.deps.budget) return undefined;
    const since = lastOwnerAt(context.sources, session.createdAt);
    const check = await this.deps.budget.checkIn(session.id, since);
    if (!check.over) return undefined;
    return `This has cost ${check.spent.toString()} so far. Keep going?`;
  }

  /**
   * Ends the turn as `waiting`: the question is stored as Shitsuji's reply, so the owner's next
   * message (a `resume` turn) sees both the question and the answer. One transaction: `wait`,
   * compare-and-set from `running`, and the question row. Returns false without storing the message
   * when another process changed the turn; the caller then returns without publishing.
   */
  private async pause(turn: Turn, session: Session, question: string): Promise<boolean> {
    const now = this.deps.clock.now();
    return this.deps.repos.uow.run(async (tx) => {
      turn.wait(now);
      if (!(await this.deps.repos.turns.update(turn, 'running', tx))) return false;
      await this.deps.repos.messages.append(
        {
          id: newId(),
          threadId: session.threadId,
          sessionId: session.id,
          turnId: turn.id,
          role: 'assistant',
          author: 'assistant',
          parts: [{ type: 'text', text: question }],
          withdrawn: false,
          createdAt: now,
        },
        tx,
      );
      return true;
    });
  }

  /**
   * An owner message steered into this turn after the last model call was sent. It queries the
   * turn's owner messages directly and compares their ids with the ones the context was built from;
   * any owner message that is not withdrawn and not in that context means the loop must run another
   * step instead of replying. There is no size window, so an older steer cannot be missed.
   */
  private async hasSteeredMessage(turn: Turn, sent: Message[]): Promise<boolean> {
    const seen = new Set(sent.map((m) => m.id));
    const owner = await this.deps.repos.messages.listOwnerByTurn(turn.id);
    return owner.some((m) => !m.withdrawn && !seen.has(m.id));
  }

  /**
   * A turn ended elsewhere (recovery after a crash, another process's Stop) must not keep running here:
   * it would spend tokens and write into a conversation that has moved on. One database read per step
   * after the first; a missing turn is also `TurnEnded`. Throws instead of returning a flag because
   * the loop's catch path turns it into the turn's `failed` state.
   */
  private async assertStillRunning(turn: Turn): Promise<void> {
    const stored = await this.deps.repos.turns.get(turn.id);
    if (stored?.status !== 'running') {
      throw new TurnEnded(`The turn was ended elsewhere (now ${stored?.status ?? 'missing'})`);
    }
  }

  /**
   * One chat-model call. Builds the request from the built context (system prompt when present,
   * messages, the tool specs — omitted when empty — temperature 0.7, 4096 output tokens and the
   * turn/session metadata), publishes `llm.request`, then awaits `ModelRouter.complete` with the
   * turn's abort signal. Streaming text deltas are republished as `turn.text_delta`; the final
   * response is followed by an `llm.response` event and a `model_call` turn-event row (model ref,
   * usage, finish reason). On a non-abort error it publishes `llm.error`, appends a `model_error`
   * row and rethrows; an abort is rethrown without an error event because Stop owns that path. No
   * retry happens here: a model request is never retried after a tool call has been emitted.
   */
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
      metadata: { turnId: turn.id, sessionId: session.id, background: turn.isBackground },
    };
    if (!request.tools?.length) delete request.tools;
    const needs = containsImages(context.messages) ? (['vision'] as const) : [];
    events.publish('llm.request', {
      agentId: agentName,
      sessionId: session.id,
      model: models.select('chat', needs).ref,
    });
    try {
      const { response, binding } = await models.complete('chat', request, {
        needs,
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

  /**
   * Runs one tool call through the pipeline, in the model's order, and turns its outcome into a
   * stored tool result. Publishes `tool.started` and `tool.called` before execution, awaits the
   * pipeline (which may itself await an approval card), then checks the abort signal again so a Stop
   * during a slow tool cannot use its result. Publishes `tool.finished` with `ok`, plus
   * `tool.result` or `tool.error`; a `repeated_failure` error becomes `TurnEnded` to stop the loop
   * rather than retrying forever. The files a tool staged are returned for the reply. The pipeline
   * receives `writeFenced`, so its writes hold the turn's row lock and fail after a Stop.
   */
  private async executeTool(
    session: Session,
    turn: Turn,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{
    /** What the model is told, including the pipeline's wrapping. */
    content: string;
    /** True when the outcome was an error, so the stall detector counts the round. */
    isError: boolean;
    /** Files the tool staged for this turn's reply. */
    files: OutboundFile[];
    /** Images the tool staged for the model, by reference. */
    images?: ToolImage[];
  }> {
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
      background: turn.isBackground,
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
    return {
      content: outcomeText(outcome),
      isError: !ok,
      files: outboundFiles(outcome),
      ...(outcome.images?.length && { images: outcome.images }),
    };
  }

  /**
   * Appends one message row for this turn (assistant content or a tool result) with the injected
   * clock and `withdrawn: false`. Awaiting it is part of the step: the next context build reads it.
   * The optional transaction is unused by the loop today but keeps the method usable inside a
   * larger unit of work.
   */
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

  /**
   * Applies a transition in memory, then saves it with compare-and-set from `expected` (`running`
   * today). Returns whether the row was saved. On false another process moved the turn first: a
   * warning is logged, the local object stays mutated but is not stored, and the caller must not
   * publish a terminal event or log the turn as failed.
   */
  private async save(turn: Turn, expected: Turn['status'], apply: () => void): Promise<boolean> {
    apply();
    const saved = await this.deps.repos.turns.update(turn, expected);
    if (!saved) this.deps.log.warn('Turn was changed elsewhere', { turnId: turn.id, expected });
    return saved;
  }
}

/**
 * The owner message the check-in counts from: the last owner message in the context that is not
 * withdrawn, or the session's creation time when there is none. The context is in transcript order,
 * so the scan runs backwards and stops at the first owner message.
 */
function lastOwnerAt(messages: readonly Message[], fallback: Date): Date {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.author === 'owner' && !message.withdrawn) return message.createdAt;
  }
  return fallback;
}

/** True when a request carries pixels, so the model call must ask for the vision capability. */
function containsImages(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) => part.type === 'image' || (part.type === 'tool_result' && !!part.images?.length),
    ),
  );
}
