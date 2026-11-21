import { serializeError } from '../../domain/errors.js';
import { newId, type OwnerId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import type { Logger } from '../../ports/Logger.js';
import { Session, type SessionKind } from '../../domain/model/Session.js';
import type { Thread } from '../../domain/model/Thread.js';
import { Turn, type TurnSource } from '../../domain/model/Turn.js';
import type { Clock } from '../../ports/Clock.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { JobQueue } from '../../ports/JobQueue.js';
import type { Repositories, Transaction } from '../../ports/Repositories.js';

/** The queue name of the wake-up job: one queued drain per session, keyed by its id. */
export const DRAIN_JOB = 'session.drain';

/** What a caller may set when it stores a message; every field has a sensible default. */
export interface SubmitOptions {
  /** Defaults to the owner's main chat session. */
  sessionId?: SessionId;
  /** Where the reply goes, e.g. "webhook:client-42" or "tui". */
  replyChannel?: string;
  /** The channel it came in on, stored with the message. */
  channel?: string;
  /** What starts the turn, when it starts one; defaults to `user`, or `resume` after a question. */
  source?: TurnSource;
}

/** What `submit` returns: the session and turn that now answer the message. */
export interface Submitted {
  /** The session the message was stored in. */
  sessionId: SessionId;
  /** The turn that will answer it, new or already running. */
  turnId: TurnId;
  /** True when the message joined a turn that was already running (steering). */
  steered: boolean;
}

/**
 * Stores an owner message and makes sure a turn answers it: a new queued turn (woken through the job
 * queue, in the same transaction), the session's existing queued turn, or the running turn (steering).
 */
export class MessageIntake {
  constructor(
    /** The runtime's dependencies; a test builds it with the in-memory repositories. */
    private readonly deps: {
      /** The owner whose thread and sessions the messages go to. */
      ownerId: OwnerId;
      /** Storage for the message, the turn and the wake-up job, in one transaction. */
      repos: Repositories;
      /** The durable queue that wakes the session's drain worker. */
      jobs: JobQueue;
      /** Injected clock for the message and turn timestamps. */
      clock: Clock;
      /** The bus for `message.received`, `turn.steered` and `session.created`. */
      events: EventBus;
      /** The agent's name, used in `session.created` and in its log lines. */
      agentName: string;
      /** Optional structured logger; without one, a failed supersede is silent. */
      log?: Logger;
      /** Expires the session's pending approval cards; a new message supersedes them (#51). */
      supersedeApprovals?: (sessionId: SessionId, reason: string) => Promise<number>;
    },
  ) {}

  /** Stores the message and returns the turn that answers it; see the class comment. */
  async submit(content: string, opts: SubmitOptions = {}): Promise<Submitted> {
    const { repos, clock, events } = this.deps;
    const result = await repos.uow.run(async (tx) => {
      const thread = await repos.threads.getOrCreateForOwner(this.deps.ownerId, clock.now(), tx);
      const session = await this.resolveSession(thread, opts.sessionId, tx);
      const turns = await repos.turns.listBySession(session.id, tx);
      const running = turns.find((t) => t.status === 'running');
      const queued = turns.find((t) => t.status === 'queued');
      // A waiting turn asked a question or paused at the check-in; the owner's next message ends it
      // and continues the session as a resume turn (F04, S28, #30).
      const waiting =
        !running && !queued && turns.at(-1)?.status === 'waiting' ? turns.at(-1) : undefined;
      const turn =
        running ??
        queued ??
        Turn.create({
          id: newId(),
          sessionId: session.id,
          source: opts.source ?? (waiting ? 'resume' : 'user'),
          createdAt: clock.now(),
          replyChannel: opts.replyChannel,
        });
      if (!running && !queued) {
        if (waiting) {
          waiting.answered(clock.now());
          await repos.turns.update(waiting, 'waiting', tx);
        }
        await repos.turns.insert(turn, tx);
      }
      await repos.messages.append(
        {
          id: newId(),
          threadId: session.threadId,
          sessionId: session.id,
          turnId: turn.id,
          role: 'user',
          author: 'owner',
          parts: [{ type: 'text', text: content }],
          channel: opts.channel,
          withdrawn: false,
          createdAt: clock.now(),
        },
        tx,
      );
      if (!running) {
        await this.deps.jobs.enqueue(
          DRAIN_JOB,
          { sessionId: session.id },
          { singletonKey: session.id },
          tx,
        );
      }
      return { sessionId: session.id, turnId: turn.id, steered: !!running };
    });
    // The message is stored; the owner has moved on, so any card waiting for them in this session
    // is superseded. A failure here must not lose the message.
    if (this.deps.supersedeApprovals) {
      try {
        const superseded = await this.deps.supersedeApprovals(
          result.sessionId,
          'the owner sent a new message',
        );
        if (superseded) {
          this.deps.log?.info('Superseded pending approvals', {
            sessionId: result.sessionId,
            count: superseded,
          });
        }
      } catch (error) {
        this.deps.log?.warn('Could not supersede pending approvals', {
          sessionId: result.sessionId,
          error: serializeError(error),
        });
      }
    }
    events.publish('message.received', { sessionId: result.sessionId, role: 'user', content });
    if (result.steered)
      events.publish('turn.steered', { turnId: result.turnId, sessionId: result.sessionId });
    else
      events.publish('turn.status', {
        turnId: result.turnId,
        sessionId: result.sessionId,
        status: 'queued',
      });
    return result;
  }

  /** Starts a new session in the owner's thread, e.g. a fresh conversation in the TUI. */
  async startSession(kind: SessionKind = 'chat'): Promise<SessionId> {
    const { repos, clock } = this.deps;
    return repos.uow.run(async (tx) => {
      const thread = await repos.threads.getOrCreateForOwner(this.deps.ownerId, clock.now(), tx);
      return (await this.createSession(thread, kind, tx)).id;
    });
  }

  /**
   * After a turn ends: if the last owner message has no answer (it arrived just as the turn was
   * finishing), queue a turn for it, so it is not lost.
   */
  async requeueIfUnanswered(sessionId: SessionId): Promise<boolean> {
    const { repos, clock } = this.deps;
    return repos.uow.run(async (tx) => {
      const turns = await repos.turns.listBySession(sessionId, tx);
      if (turns.some((t) => t.status === 'queued' || t.status === 'running')) return false;
      const recent = await repos.messages.listBySession(sessionId, { limit: 20 }, tx);
      const lastOwner = recent.findLastIndex((m) => m.author === 'owner' && !m.withdrawn);
      const lastReply = recent.findLastIndex(
        (m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'),
      );
      if (lastOwner === -1 || lastReply > lastOwner) return false;
      const ownerTurn = turns.find((t) => t.id === recent[lastOwner]!.turnId);
      if (ownerTurn && ownerTurn.status !== 'succeeded') return false; // failed/cancelled: not ours to retry
      const turn = Turn.create({
        id: newId(),
        sessionId,
        source: 'user',
        createdAt: clock.now(),
        replyChannel: ownerTurn?.toProps().replyChannel,
      });
      await repos.turns.insert(turn, tx);
      await this.deps.jobs.enqueue(DRAIN_JOB, { sessionId }, { singletonKey: sessionId }, tx);
      return true;
    });
  }

  /** The named session if it belongs to the thread, else the thread's main chat, creating it if needed. */
  private async resolveSession(thread: Thread, id: SessionId | undefined, tx: Transaction) {
    const { repos } = this.deps;
    if (id) {
      const session = await repos.sessions.get(id, tx);
      if (!session || session.threadId !== thread.id) throw new Error(`Session ${id} not found`);
      return session;
    }
    return (
      (await repos.sessions.findMainChat(thread.id, tx)) ?? this.createSession(thread, 'chat', tx)
    );
  }

  /** Inserts a session in the caller's transaction and announces it; `/new` and the first message use it. */
  private async createSession(
    thread: Thread,
    kind: SessionKind,
    tx: Transaction,
  ): Promise<Session> {
    const session = new Session(newId(), thread.id, kind, this.deps.clock.now());
    await this.deps.repos.sessions.insert(session, tx);
    this.deps.events.publish('session.created', {
      sessionId: session.id,
      agentId: this.deps.agentName,
    });
    return session;
  }
}
