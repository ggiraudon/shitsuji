import type { OwnerId, SessionId, TurnId } from '../domain/model/ids.js';
import type { SessionKind } from '../domain/model/Session.js';
import type { Clock } from '../ports/Clock.js';
import type { ContextInjectable } from '../ports/ContextInjectable.js';
import type { EventBus } from '../ports/EventBus.js';
import type { JobQueue } from '../ports/JobQueue.js';
import type { Logger } from '../ports/Logger.js';
import type { Repositories } from '../ports/Repositories.js';
import type { Tool } from '../ports/Tool.js';
import {
  ClockInjectable,
  CompactionSummaryInjectable,
  Compactor,
  IdentityInjectable,
  OwnerProfileInjectable,
  RulesInjectable,
  SoulInjectable,
  ToolIndexInjectable,
} from './context/index.js';
import { ContextBuilder } from './context/ContextBuilder.js';
import type { ImageSource } from './context/ContextBuilder.js';
import type { ModelRouter } from './models/ModelRouter.js';
import type { BudgetService } from './budget/BudgetService.js';
import type { SoulSource } from './soul/SoulService.js';
import type { ApprovalService } from './trust/ApprovalService.js';
import type { StepLimits } from './runtime/limits.js';
import { MessageIntake, type Submitted, type SubmitOptions } from './runtime/MessageIntake.js';
import { StopController } from './runtime/StopController.js';
import { TurnRunner } from './runtime/TurnRunner.js';
import { TurnScheduler } from './runtime/TurnScheduler.js';
import type { ToolCatalog } from './tools/ToolCatalog.js';
import type { ToolPipeline } from './tools/ToolPipeline.js';

/** Everything the runtime needs; `createShitsuji()` builds it, tests pass in-memory adapters. */
export interface AgentOptions {
  /** The agent's name, used in identity context and in `agentId` on events. */
  name: string;
  /** The single owner whose thread and sessions this agent uses. */
  ownerId: OwnerId;
  /** Picks the model for each call by purpose ("chat" here). */
  models: ModelRouter;
  /** Every call goes through this pipeline (validation, trust, receipts…). */
  pipeline: ToolPipeline;
  /** The tools the model can call. The pipeline looks tools up in the same catalog. */
  tools: ToolCatalog;
  /** Sessions, turns, messages and the unit of work; the only persistence this runtime touches. */
  repos: Repositories;
  /** Wakes queued turns (session.drain). */
  jobs: JobQueue;
  /** Injected clock; tests use a manual one. */
  clock: Clock;
  /** Structured logger; context-building and turn failures are reported here. */
  log: Logger;
  /** The bus turns publish to and `Shitsuji`/the API subscribe to. */
  events: EventBus;
  /** The assembled standing instructions, fixed per turn (Q6). */
  soul?: SoulSource;
  /** The check-in limit; absent when the run has no budget (unit tests). */
  budget?: BudgetService;
  /** Cards waiting for the owner; a new message supersedes the session's pending ones (#51). */
  approvals?: ApprovalService;
  /** How many recent messages are sent to the model (default 40). */
  historyLimit?: number;
  /** How many of the newest images stay pixels; older ones become placeholders (default 3, S52). */
  imageHistoryLimit?: number;
  /** Raw bytes allowed per image; bigger files become a placeholder (default 5 MiB, S52). */
  imageMaxBytes?: number;
  /** Whether any chat candidate has vision; false keeps every image as a placeholder (S52). */
  visionAvailable?: boolean;
  /** Loads a stored image reference from the active sandbox at context-build time. */
  images?: ImageSource;
  /** Model calls per turn by session kind (decision Q5). */
  limits?: Partial<StepLimits>;
  /** Warn when a header injectable changes on every call (default on: tests and development). */
  stabilityCheck?: boolean;
  /**
   * How long `send()` waits for a turn's terminal event before rejecting (S49). Defaults to
   * 30 minutes; a lost event must not leave the caller and its subscription pending forever.
   */
  sendTimeoutMs?: number;
}

/** How long `send()` waits by default for the terminal event of a turn it submitted. */
const DEFAULT_SEND_TIMEOUT_MS = 30 * 60_000;

/** Options a channel or the API passes when it stores a message; see `MessageIntake.submit`. */
export type SendOptions = SubmitOptions;

/** What `send()` resolves to: the final reply (or the question of a `waiting` turn) and its ids. */
export interface SendResult {
  /** The assistant's text, or the question when the status is `waiting`. */
  reply: string;
  /** The session the turn belongs to. */
  sessionId: SessionId;
  /** The turn that produced the reply. */
  turnId: TurnId;
  /** `waiting` means Shitsuji asked a question and the owner's next message continues. */
  status: 'succeeded' | 'waiting';
}

/**
 * The assistant's runtime behind one facade (F04): `MessageIntake` stores messages and queues turns,
 * `TurnScheduler` starts them one at a time per session, `TurnRunner` runs the model/tool loop and
 * `StopController` aborts them. This class wires those four together and exposes the small surface
 * channels, the API and the TUI use; it does not itself call a model or write a turn.
 *
 * ```mermaid
 * flowchart LR
 *   submit --> intake
 *   intake -->|message + queued turn| turns[(turns)]
 *   turns --> scheduler
 *   scheduler -->|one per session| runner
 *   runner -->|turn.status| events
 * ```
 *
 * One `Agent` exists per core process (`createShitsuji`). It is constructed once, started once after
 * the job queue (`start()`), and stopped by letting `Shitsuji.stop()` wait on `idle()`.
 */
export class Agent {
  /** The agent's name, also passed to intake events and the identity context. */
  readonly name: string;
  /** Stores owner messages and turns; the only writer of user messages. */
  private readonly intake: MessageIntake;
  /** Registers `session.drain` and runs detached turns. */
  private readonly scheduler: TurnScheduler;
  /** In-process AbortControllers for the turns this process is running. */
  private readonly stops = new StopController();
  /** The live tool catalog shared with the pipeline and the tool-index injectable. */
  private readonly tools: ToolCatalog;
  /** Context injectables, in construction order; plugins may append after the agent is built. */
  private injectables: ContextInjectable[];

  /**
   * Builds the standard injectables (identity, SOUL, tool index, rules, owner profile, clock,
   * compaction summary), the intake, the context builder with its compactor, the runner and the
   * scheduler. No I/O happens here; the only external read is the chat model's context window,
   * which is looked up through the router and may be absent.
   */
  constructor(
    /** The options `createShitsuji` filled in; the runtime reads them once and builds its parts. */
    private readonly options: AgentOptions,
  ) {
    this.name = options.name;
    this.tools = options.tools;
    this.injectables = [
      new IdentityInjectable({ name: this.name, description: 'a helpful AI assistant' }),
      new SoulInjectable(),
      new ToolIndexInjectable(() => this.tools.list()),
      new RulesInjectable([
        { id: 'helpful', text: 'Be helpful and concise' },
        { id: 'safe', text: 'Do not reveal sensitive information' },
      ]),
      new OwnerProfileInjectable(),
      new ClockInjectable(options.clock),
      new CompactionSummaryInjectable(),
    ];
    const approvals = options.approvals;
    this.intake = new MessageIntake({
      ...options,
      agentName: this.name,
      ...(approvals && {
        supersedeApprovals: (sessionId, reason) => approvals.supersedeForSession(sessionId, reason),
      }),
    });
    const contextWindow = contextWindowOf(options.models);
    const visionAvailable = options.visionAvailable ?? options.models.anySupports('chat', 'vision');
    const context = new ContextBuilder({
      injectables: () => this.injectables,
      repos: options.repos,
      ownerId: options.ownerId,
      log: options.log,
      historyLimit: options.historyLimit ?? 40,
      ...(options.imageHistoryLimit !== undefined && {
        imageHistoryLimit: options.imageHistoryLimit,
      }),
      ...(options.imageMaxBytes !== undefined && { imageMaxBytes: options.imageMaxBytes }),
      visionAvailable,
      ...(options.images && { images: options.images }),
      stabilityCheck: options.stabilityCheck ?? true,
      compactor: new Compactor({
        models: options.models,
        sessions: options.repos.sessions,
        clock: options.clock,
        log: options.log,
      }),
      ...(contextWindow !== undefined && { contextWindow }),
    });
    const runner = new TurnRunner({
      agentName: this.name,
      models: options.models,
      tools: this.tools,
      pipeline: options.pipeline,
      repos: options.repos,
      clock: options.clock,
      log: options.log,
      events: options.events,
      stops: this.stops,
      context,
      ...(options.soul && { soul: options.soul }),
      ...(options.budget && { budget: options.budget }),
      limits: options.limits,
    });
    this.scheduler = new TurnScheduler({ ...options, runner, intake: this.intake });
  }

  /**
   * Registers the `session.drain` worker and wakes every session that still has queued turns (after
   * a restart). Must be called after the job queue has started; `Shitsuji.start()` does both in that
   * order. Awaits the worker registration and every wake-up enqueue; errors propagate.
   */
  async start(): Promise<void> {
    await this.scheduler.start();
  }

  /**
   * Resolves when no turn **this scheduler started** is still running; used by shutdown (with a
   * five-second cap in `Shitsuji.stop`) and by tests. It does not wait for turns started by another
   * process, and a drain that starts a new turn while it waits can extend it.
   */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  /**
   * Adds a context injectable; the `ContextBuilder` places it by its placement and order on the
   * **next** build, so a running turn keeps the context it already assembled.
   */
  addInjectable(injectable: ContextInjectable): void {
    this.injectables.push(injectable);
  }

  /** The live tool catalog, for `/tools` and tests; the same objects the pipeline can call. */
  getTools(): Tool[] {
    return this.tools.list();
  }

  /**
   * Adds a tool after construction (plugins do this while they register). The change is visible to
   * the next model request and the next tool lookup; it does not rewrite a request in flight.
   */
  registerTool(tool: Tool): void {
    this.tools.add(tool);
  }

  /**
   * Starts a new session in the owner's thread, e.g. a fresh conversation from `/new` or the TUI.
   * It creates no turn and calls no model; the next `submit` targets it.
   */
  startSession(kind: SessionKind = 'chat'): Promise<SessionId> {
    return this.intake.startSession(kind);
  }

  /**
   * Stores an owner message and makes sure a turn answers it, returning as soon as the transaction
   * commits: it never waits for the model. `MessageIntake` decides whether the message starts a new
   * queued turn (and enqueues `session.drain` in the same transaction), joins the session's queued
   * turn, or steers into the running turn. A `waiting` turn ends here and the message starts a
   * `resume` turn. Errors come from the transaction and propagate to the channel.
   */
  submit(content: string, opts: SubmitOptions = {}): Promise<Submitted> {
    return this.intake.submit(content, opts);
  }

  /**
   * Stops a turn: a running one in this process is aborted (its request withdrawn), a queued one is
   * cancelled with a compare-and-set and a `turn.status: cancelled` event. Returns false if the turn
   * is already over, missing, or running in **another** process (that process's Stop, not this one,
   * must cancel it). Aborting does not wait for the runner to write `cancelled`.
   */
  async stop(turnId: TurnId): Promise<boolean> {
    if (this.stops.stop(turnId)) return true;
    const { repos, clock, events } = this.options;
    const turn = await repos.turns.get(turnId);
    if (!turn || turn.status !== 'queued') return false;
    turn.cancel(clock.now(), 'stopped by owner');
    if (!(await repos.turns.update(turn, 'queued'))) return false;
    events.publish('turn.status', {
      turnId,
      sessionId: turn.sessionId,
      status: 'cancelled',
      error: 'stopped by owner',
    });
    return true;
  }

  /**
   * Stops the newest running turn of a session, or failing that the newest queued one; used by
   * `/stop` and the TUI's Escape. A running turn wins over a newer queued turn because it is the one
   * spending money now. Returns false when the session is idle or the chosen turn is already over.
   */
  async stopSession(sessionId: SessionId): Promise<boolean> {
    const turns = await this.options.repos.turns.listBySession(sessionId);
    const running = [...turns].reverse().find((t) => t.status === 'running');
    if (running) return this.stop(running.id);
    const queued = [...turns].reverse().find((t) => t.status === 'queued');
    return queued ? this.stop(queued.id) : false;
  }

  /**
   * `submit()` and wait for the reply, for callers that want one answer in-process (the evaluation
   * harness and tests). It subscribes **before** submitting and remembers a terminal event that
   * arrives before it installs its waiting promise, so a fast turn cannot finish unseen. A succeeded
   * or waiting turn resolves; a failed or cancelled turn throws its reason. The wait is bounded by
   * `sendTimeoutMs` (30 minutes by default): on timeout it rejects with a clear error and removes
   * the subscription in `finally`, so a lost terminal event cannot leak the listener or leave the
   * caller pending forever. The turn itself is not stopped by the timeout; use `stop()` for that.
   */
  async send(content: string, opts: SendOptions = {}): Promise<SendResult> {
    // Subscribe before submitting and remember every ending, so a fast turn cannot finish unseen.
    const ended = new Map<string, SendResult | Error>();
    let waiting: { turnId: string; settle: (r: SendResult | Error) => void } | undefined;
    const off = this.options.events.subscribe('turn.status', (e) => {
      let result: SendResult | Error;
      if (e.status === 'succeeded' || e.status === 'waiting') {
        result = {
          reply: e.status === 'waiting' ? (e.question ?? '') : (e.reply ?? ''),
          sessionId: e.sessionId as SessionId,
          turnId: e.turnId as TurnId,
          status: e.status,
        };
      } else if (e.status === 'failed' || e.status === 'cancelled') {
        result = new Error(e.error ?? e.status);
      } else {
        return;
      }
      if (waiting?.turnId === e.turnId) waiting.settle(result);
      else ended.set(e.turnId, result);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const { turnId } = await this.submit(content, opts);
      const settled = ended.get(turnId);
      const result =
        settled ??
        (await Promise.race([
          new Promise<SendResult | Error>((settle) => (waiting = { turnId, settle })),
          new Promise<never>((_, reject) => {
            const timeoutMs = this.options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `The turn did not finish within ${timeoutMs} ms; its reply may still arrive on its channel.`,
                  ),
                ),
              timeoutMs,
            );
            timer.unref?.();
          }),
        ]));
      if (result instanceof Error) throw result;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      off();
    }
  }
}

/**
 * The chat model's context window when the catalogue knows it; without one the context builder
 * only enforces the message limit. A missing `chat` purpose is swallowed here (the schema usually
 * rejects it first), so a test router without metadata still works.
 */
function contextWindowOf(models: ModelRouter): number | undefined {
  try {
    return models.select('chat').info?.contextWindow;
  } catch {
    return undefined;
  }
}
