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
import type { ModelRouter } from './models/ModelRouter.js';
import type { SoulSource } from './soul/SoulService.js';
import type { StepLimits } from './runtime/limits.js';
import { MessageIntake, type Submitted, type SubmitOptions } from './runtime/MessageIntake.js';
import { StopController } from './runtime/StopController.js';
import { TurnRunner } from './runtime/TurnRunner.js';
import { TurnScheduler } from './runtime/TurnScheduler.js';
import type { ToolCatalog } from './tools/ToolCatalog.js';
import type { ToolPipeline } from './tools/ToolPipeline.js';

export interface AgentOptions {
  name: string;
  ownerId: OwnerId;
  /** Picks the model for each call by purpose ("chat" here). */
  models: ModelRouter;
  /** Every call goes through this pipeline (validation, trust, receipts…). */
  pipeline: ToolPipeline;
  /** The tools the model can call. The pipeline looks tools up in the same catalog. */
  tools: ToolCatalog;
  repos: Repositories;
  /** Wakes queued turns (session.drain). */
  jobs: JobQueue;
  clock: Clock;
  log: Logger;
  events: EventBus;
  /** The assembled standing instructions, fixed per turn (Q6). */
  soul?: SoulSource;
  /** How many recent messages are sent to the model. */
  historyLimit?: number;
  /** Model calls per turn by session kind (decision Q5). */
  limits?: Partial<StepLimits>;
  /** Warn when a header injectable changes on every call (default on: tests and development). */
  stabilityCheck?: boolean;
}

export type SendOptions = SubmitOptions;

export interface SendResult {
  reply: string;
  sessionId: SessionId;
  turnId: TurnId;
}

/**
 * The assistant's runtime behind one facade (F04): MessageIntake stores messages and queues turns,
 * TurnScheduler starts them one at a time per session, TurnRunner runs them, StopController stops them.
 */
export class Agent {
  readonly name: string;
  private readonly intake: MessageIntake;
  private readonly scheduler: TurnScheduler;
  private readonly stops = new StopController();
  private readonly tools: ToolCatalog;
  private injectables: ContextInjectable[];

  constructor(private readonly options: AgentOptions) {
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
    this.sortInjectables();
    this.intake = new MessageIntake({ ...options, agentName: this.name });
    const contextWindow = contextWindowOf(options.models);
    const context = new ContextBuilder({
      injectables: () => this.injectables,
      repos: options.repos,
      ownerId: options.ownerId,
      log: options.log,
      historyLimit: options.historyLimit,
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
      limits: options.limits,
    });
    this.scheduler = new TurnScheduler({ ...options, runner, intake: this.intake });
  }

  /** Registers the turn worker and resumes queued turns. Call once the job queue has started. */
  async start(): Promise<void> {
    await this.scheduler.start();
  }

  /** Waits until no turn started here is still running. */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  addInjectable(injectable: ContextInjectable): void {
    this.injectables.push(injectable);
    this.sortInjectables();
  }

  getTools(): Tool[] {
    return this.tools.list();
  }

  registerTool(tool: Tool): void {
    this.tools.add(tool);
  }

  startSession(kind: SessionKind = 'chat'): Promise<SessionId> {
    return this.intake.startSession(kind);
  }

  /** Stores an owner message and queues (or steers into) a turn. Returns at once. */
  submit(content: string, opts: SubmitOptions = {}): Promise<Submitted> {
    return this.intake.submit(content, opts);
  }

  /**
   * Stops a turn: a running one is aborted (its request withdrawn), a queued one is cancelled.
   * Returns false if the turn is already over.
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

  /** submit() and wait for the reply. Throws with the reason if the turn fails or is stopped. */
  async send(content: string, opts: SendOptions = {}): Promise<SendResult> {
    // Subscribe before submitting and remember every ending, so a fast turn cannot finish unseen.
    const ended = new Map<string, SendResult | Error>();
    let waiting: { turnId: string; settle: (r: SendResult | Error) => void } | undefined;
    const off = this.options.events.subscribe('turn.status', (e) => {
      let result: SendResult | Error;
      if (e.status === 'succeeded') {
        result = {
          reply: e.reply ?? '',
          sessionId: e.sessionId as SessionId,
          turnId: e.turnId as TurnId,
        };
      } else if (e.status === 'failed' || e.status === 'cancelled') {
        result = new Error(e.error ?? e.status);
      } else {
        return;
      }
      if (waiting?.turnId === e.turnId) waiting.settle(result);
      else ended.set(e.turnId, result);
    });
    try {
      const { turnId } = await this.submit(content, opts);
      const result =
        ended.get(turnId) ??
        (await new Promise<SendResult | Error>((settle) => (waiting = { turnId, settle })));
      if (result instanceof Error) throw result;
      return result;
    } finally {
      off();
    }
  }

  /** Placement first (header, context, tail), then ascending order within each (F04). */
  private sortInjectables(): void {
    const rank = { header: 0, context: 1, tail: 2 } as const;
    this.injectables.sort(
      (a, b) =>
        rank[a.placement] - rank[b.placement] || a.order - b.order || a.id.localeCompare(b.id),
    );
  }
}

/** The chat model's context window, when the catalogue knows it; without one, no compaction. */
function contextWindowOf(models: ModelRouter): number | undefined {
  try {
    return models.select('chat').info?.contextWindow;
  } catch {
    return undefined;
  }
}
