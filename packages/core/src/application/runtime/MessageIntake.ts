import { newId, type OwnerId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import { Session, type SessionKind } from '../../domain/model/Session.js';
import type { Thread } from '../../domain/model/Thread.js';
import { Turn, type TurnSource } from '../../domain/model/Turn.js';
import type { Clock } from '../../ports/Clock.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { JobQueue } from '../../ports/JobQueue.js';
import type { Repositories, Transaction } from '../../ports/Repositories.js';

export const DRAIN_JOB = 'session.drain';

export interface SubmitOptions {
  /** Defaults to the owner's main chat session. */
  sessionId?: SessionId;
  /** Where the reply goes, e.g. "webhook:client-42" or "tui". */
  replyChannel?: string;
  /** The channel it came in on, stored with the message. */
  channel?: string;
  source?: TurnSource;
}

export interface Submitted {
  sessionId: SessionId;
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
    private readonly deps: {
      ownerId: OwnerId;
      repos: Repositories;
      jobs: JobQueue;
      clock: Clock;
      events: EventBus;
      agentName: string;
    },
  ) {}

  async submit(content: string, opts: SubmitOptions = {}): Promise<Submitted> {
    const { repos, clock, events } = this.deps;
    const result = await repos.uow.run(async (tx) => {
      const thread = await repos.threads.getOrCreateForOwner(this.deps.ownerId, clock.now(), tx);
      const session = await this.resolveSession(thread, opts.sessionId, tx);
      const turns = await repos.turns.listBySession(session.id, tx);
      const running = turns.find((t) => t.status === 'running');
      const queued = turns.find((t) => t.status === 'queued');
      const turn =
        running ??
        queued ??
        Turn.create({
          id: newId(),
          sessionId: session.id,
          source: opts.source ?? 'user',
          createdAt: clock.now(),
          replyChannel: opts.replyChannel,
        });
      if (!running && !queued) await repos.turns.insert(turn, tx);
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
