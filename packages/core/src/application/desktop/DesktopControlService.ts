import { SandboxUnavailable } from '../../domain/errors.js';
import { newId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import { textOf } from '../../domain/model/Message.js';
import { Turn } from '../../domain/model/Turn.js';
import type { Clock } from '../../ports/Clock.js';
import type {
  AgentTakeoverAnswer,
  AgentTakeoverRequest,
  DesktopControl,
  DesktopControlMode,
  DesktopControlStatus,
} from '../../ports/DesktopControl.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { JobQueue } from '../../ports/JobQueue.js';
import type { Logger } from '../../ports/Logger.js';
import type { Repositories } from '../../ports/Repositories.js';
import type { FullViewerCredentials } from '../../ports/SandboxDriver.js';
import type { ToolImage } from '../../ports/Tool.js';
import { DRAIN_JOB } from '../runtime/MessageIntake.js';

/** The runner stores this prefix as the pause question, so a restart can recognise it. */
export const AGENT_TAKEOVER_PREFIX = 'The agent asked for control of the desktop.';
/** The runner stores this prefix when the owner pressed Take control; a restart recognises it too. */
export const OWNER_TAKEOVER_PREFIX = 'The owner took control of the desktop.';

/** How long the owner may keep control without giving it back: 15 minutes. */
export const DEFAULT_TAKEOVER_TIMEOUT_MS = 15 * 60_000;

/**
 * The part of `SandboxService` the control service uses. Tests pass a small fake; the real service
 * owns the mode, the full credential and the screenshot.
 */
export interface ControlSandbox {
  /** Who drives now; `owner` refuses the agent's writes, not its reads. */
  readonly desktopMode: DesktopControlMode;
  /** Switches to owner mode; `requestedBy` says whether the agent asked or the owner pressed. */
  enterOwnerControl(input: { requestedBy: 'agent' | 'owner'; reason?: string; since: Date }): void;
  /** Returns to agent mode; the viewer's full streams close from the mode-change listener. */
  leaveOwnerControl(): void;
  /** The display's control password, read from sandboxd only while owner mode holds. */
  fullViewerCredentials(): Promise<FullViewerCredentials>;
  /** A fresh screenshot for the resumed turn, when vision is available. */
  captureScreenshot(sessionId: SessionId, turnId: TurnId): Promise<ToolImage | undefined>;
  /** Notifies on every mode change; returns the unsubscribe function. */
  onDesktopModeChange(listener: (mode: DesktopControlMode) => void): () => void;
}

/** What the control service needs: the sandbox, storage, jobs, events, the clock and the limits. */
export interface DesktopControlDeps {
  /** The part of the sandbox service that owns the mode and the credentials. */
  sandbox: ControlSandbox;
  /** Turns, sessions and messages: pausing a turn and queueing its resume. */
  repos: Repositories;
  /** The drain queue a resumed turn goes through. */
  jobs: JobQueue;
  /** `turn.status`: resumed takeover turns follow a pending turn becoming `waiting`. */
  events: EventBus;
  /** Injected clock: the owner-mode start, the timeout and every resume timestamp use it. */
  clock: Clock;
  /** Structured logger; every take and give-back is reported here. */
  log: Logger;
  /** The viewer's URL, when the deployment has one; included in the owner's message. */
  viewerUrl?: string;
  /** Whether the vision purpose can see a screenshot; gates the image on a resumed turn. */
  vision: boolean;
  /** Override the 15-minute limit; tests shorten it. */
  timeoutMs?: number;
}

/**
 * Take control / Give back (S55). It owns the owner-mode lifetime and the turns paused by it:
 * entering owner mode refuses the agent's writes (through `SandboxService`), viewer take pauses
 * running turns, Give back resumes each paused turn with a system note and, when vision is
 * available, a fresh screenshot. Every resume is a compare-and-set from `waiting`, so a double
 * Give back cannot create two resume turns. A timeout or a restart returns the desktop to the agent
 * and resumes the turn with a note rather than leaving either stuck.
 */
export class DesktopControlService implements DesktopControl {
  /** Who entered owner mode, why and when; cleared on Give back. */
  private info?: {
    /** Whether the agent asked or the owner pressed Take control. */
    requestedBy: 'agent' | 'owner';
    /** The agent's words, when it asked. */
    reason?: string;
    /** When owner mode began. */
    since: Date;
  };
  /** When an owner who never gives back is returned to the agent; absent when the limit is off. */
  private expiresAt?: Date;
  /** The pending timeout; unref'd, so a test process can exit. */
  private timer?: NodeJS.Timeout;
  /** Unsubscribes the `turn.status` watcher; kept so `stop()` leaves no listener behind. */
  private offTurnStatus?: () => void;
  /** Turns paused by this process; Give back resumes them. */
  private readonly paused = new Map<
    TurnId,
    {
      /** The session the paused turn belongs to; its resume turn is created there. */
      sessionId: SessionId;
    }
  >();
  /** Turns that were not waiting yet when Give back ran; the waiting event resumes them. */
  private readonly pending = new Map<
    TurnId,
    {
      /** The session that owns the pending turn. */
      sessionId: SessionId;
      /** The note the resume turn gets, written when Give back ran. */
      note: string;
      /** The screenshot taken then, when vision was available. */
      image?: ToolImage;
    }
  >();

  constructor(
    /** The sandbox, storage, jobs, events, clock and limits. */
    private readonly deps: DesktopControlDeps,
  ) {}

  /** The mode the sandbox currently holds; `agent` when nobody took over. */
  get mode(): DesktopControlMode {
    return this.deps.sandbox.desktopMode;
  }

  /** What the viewer banner and `/status` show, including the expiry and the viewer URL. */
  status(): DesktopControlStatus {
    return {
      mode: this.mode,
      ...(this.info?.requestedBy && { requestedBy: this.info.requestedBy }),
      ...(this.info?.reason && { reason: this.info.reason }),
      ...(this.info?.since && { since: this.info.since.toISOString() }),
      ...(this.expiresAt && { expiresAt: this.expiresAt.toISOString() }),
      ...(this.deps.viewerUrl && { viewerUrl: this.deps.viewerUrl }),
    };
  }

  /** Registers the turn-status watcher and resumes takeover turns left by the previous process. */
  async start(): Promise<void> {
    this.offTurnStatus = this.deps.events.subscribe('turn.status', (event) => {
      const turnId = event.turnId as TurnId;
      const pending = this.pending.get(turnId);
      if (pending && event.status === 'waiting' && this.mode === 'agent') {
        void this.resume(
          { turnId, sessionId: pending.sessionId },
          pending.note,
          pending.image,
        ).then((done) => {
          if (done) this.pending.delete(turnId);
        });
      } else if (['succeeded', 'failed', 'cancelled'].includes(event.status)) {
        this.pending.delete(turnId);
        this.paused.delete(turnId);
      }
    });
    await this.resumeAfterRestart();
  }

  /** Stops watching turn status, drops the paused turns and returns the desktop to the agent. */
  stop(): void {
    this.clearExpiry();
    this.offTurnStatus?.();
    this.offTurnStatus = undefined;
    this.paused.clear();
    this.pending.clear();
    this.deps.sandbox.leaveOwnerControl();
  }

  /** The agent asks; the runner pauses the turn with the returned question. */
  async requestByAgent(request: AgentTakeoverRequest): Promise<AgentTakeoverAnswer> {
    if (this.mode === 'owner') {
      return {
        ok: false,
        message:
          'The owner already has control of the desktop. Wait for them to give it back before ' +
          'asking again.',
      };
    }
    const since = this.deps.clock.now();
    try {
      this.deps.sandbox.enterOwnerControl({
        requestedBy: 'agent',
        reason: request.reason,
        since,
      });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The desktop cannot be taken over.',
      };
    }
    this.info = { requestedBy: 'agent', reason: request.reason, since };
    this.paused.set(request.turnId, { sessionId: request.sessionId });
    this.armExpiry();
    return {
      ok: true,
      message:
        'The owner has been asked for control. This turn is paused until they give the desktop ' +
        'back.',
      question: this.agentQuestion(request.reason),
    };
  }

  /** The turn could not pause; do not leave the desktop with an owner who was never asked. */
  abandonAgentRequest(): void {
    if (this.mode !== 'owner' || this.info?.requestedBy !== 'agent') return;
    this.clearExpiry();
    this.info = undefined;
    this.paused.clear();
    this.deps.sandbox.leaveOwnerControl();
  }

  /** The owner pressed Take control; pause every running turn so it cannot keep writing. */
  async take(): Promise<DesktopControlStatus> {
    if (this.mode === 'owner') return this.status();
    const since = this.deps.clock.now();
    this.deps.sandbox.enterOwnerControl({ requestedBy: 'owner', since });
    this.info = { requestedBy: 'owner', since };
    await this.pauseRunning();
    this.armExpiry();
    this.deps.log.info('Owner took control of the desktop');
    return this.status();
  }

  /** Give back: agent mode first, then every paused turn resumes with a note and maybe a picture. */
  async giveBack(reason: 'owner' | 'timeout' = 'owner'): Promise<DesktopControlStatus> {
    if (this.mode !== 'owner') return this.status();
    this.clearExpiry();
    this.info = undefined;
    // Leave owner mode first: the viewer listener closes full-control streams immediately.
    this.deps.sandbox.leaveOwnerControl();
    const noteFor = (hasImage: boolean) =>
      reason === 'timeout' ? this.timeoutNote(hasImage) : this.ownerNote(hasImage);
    const paused = [...this.paused.entries()];
    this.paused.clear();
    let resumed = 0;
    for (const [turnId, record] of paused) {
      const image = this.deps.vision
        ? await this.deps.sandbox.captureScreenshot(record.sessionId, turnId)
        : undefined;
      const note = noteFor(Boolean(image));
      if (await this.resume({ turnId, sessionId: record.sessionId }, note, image)) resumed += 1;
      else this.pending.set(turnId, { ...record, note, ...(image && { image }) });
    }
    this.deps.log.info('Desktop returned to the agent', {
      reason,
      paused: paused.length,
      resumed,
    });
    return this.status();
  }

  /** The full-control password is never held or returned outside owner mode. */
  async fullCredentials(): Promise<FullViewerCredentials> {
    if (this.mode !== 'owner') {
      throw new SandboxUnavailable('The owner does not have control of the desktop.');
    }
    return this.deps.sandbox.fullViewerCredentials();
  }

  /** Forwards the sandbox's mode changes, so the viewer can swap streams without polling. */
  onModeChange(listener: (mode: DesktopControlMode) => void): () => void {
    return this.deps.sandbox.onDesktopModeChange(listener);
  }

  /** Pauses every turn that is running when the owner presses Take control. */
  private async pauseRunning(): Promise<void> {
    const running = await this.deps.repos.turns.listByStatus('running');
    for (const turn of running) {
      const done = await this.pauseTurn(turn, this.ownerQuestion());
      if (done) this.paused.set(turn.id, { sessionId: turn.sessionId });
    }
  }

  /** Ends one running turn as waiting with the question, using compare-and-set from `running`. */
  private async pauseTurn(turn: Turn, question: string): Promise<boolean> {
    const now = this.deps.clock.now();
    const replyChannel = turn.toProps().replyChannel;
    const done = await this.deps.repos.uow.run(async (tx) => {
      const session = await this.deps.repos.sessions.get(turn.sessionId, tx);
      if (!session) return false;
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
    if (!done) return false;
    this.deps.events.publish('turn.status', {
      turnId: turn.id,
      sessionId: turn.sessionId,
      status: 'waiting',
      question,
      ...(replyChannel && { replyChannel }),
    });
    return true;
  }

  /**
   * Ends a waiting turn and queues a `resume` turn with a system note (and an optional image). The
   * compare-and-set from `waiting` is the double-resume guard: one call wins, the other returns
   * false and never queues a second turn.
   */
  private async resume(
    record: { turnId: TurnId; sessionId: SessionId },
    note: string,
    image?: ToolImage,
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    const resume = await this.deps.repos.uow.run(async (tx) => {
      const stored = await this.deps.repos.turns.getForUpdate(record.turnId, tx);
      if (!stored || stored.status !== 'waiting') return undefined;
      const session = await this.deps.repos.sessions.get(record.sessionId, tx);
      if (!session) return undefined;
      stored.answered(now);
      if (!(await this.deps.repos.turns.update(stored, 'waiting', tx))) return undefined;
      const next = Turn.create({
        id: newId(),
        sessionId: record.sessionId,
        source: 'resume',
        createdAt: now,
        ...(stored.toProps().replyChannel && { replyChannel: stored.toProps().replyChannel }),
      });
      await this.deps.repos.turns.insert(next, tx);
      await this.deps.repos.messages.append(
        {
          id: newId(),
          threadId: session.threadId,
          sessionId: record.sessionId,
          turnId: next.id,
          role: 'system',
          author: 'system',
          parts: [
            { type: 'text', text: note },
            ...(image
              ? [
                  {
                    type: 'image' as const,
                    mediaType: image.mediaType,
                    ref: image.ref,
                    ...(image.name && { name: image.name }),
                  },
                ]
              : []),
          ],
          withdrawn: false,
          createdAt: now,
        },
        tx,
      );
      await this.deps.jobs.enqueue(
        DRAIN_JOB,
        { sessionId: record.sessionId },
        { singletonKey: record.sessionId },
        tx,
      );
      return next.id;
    });
    if (!resume) return false;
    this.deps.events.publish('turn.status', {
      turnId: resume,
      sessionId: record.sessionId,
      status: 'queued',
    });
    return true;
  }

  /** A restart leaves the mode in memory behind, so resume takeover turns with a note. */
  private async resumeAfterRestart(): Promise<void> {
    const waiting = await this.deps.repos.turns.listByStatus('waiting');
    for (const turn of waiting) {
      const messages = await this.deps.repos.messages.listBySession(turn.sessionId);
      const question = messages
        .filter((message) => message.turnId === turn.id && message.role === 'assistant')
        .map(textOf)
        .join('\n');
      if (
        !question.startsWith(AGENT_TAKEOVER_PREFIX) &&
        !question.startsWith(OWNER_TAKEOVER_PREFIX)
      ) {
        continue;
      }
      const image = this.deps.vision
        ? await this.deps.sandbox.captureScreenshot(turn.sessionId, turn.id)
        : undefined;
      if (
        await this.resume(
          { turnId: turn.id, sessionId: turn.sessionId },
          this.restartNote(Boolean(image)),
          image,
        )
      ) {
        this.deps.log.warn('Resumed a takeover turn after a restart', { turnId: turn.id });
      }
    }
  }

  /** Starts the owner-mode timeout, replacing any previous one; a zero or negative limit is off. */
  private armExpiry(): void {
    this.clearExpiry();
    const timeout = this.deps.timeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS;
    if (timeout <= 0) return;
    this.expiresAt = new Date(this.deps.clock.now().getTime() + timeout);
    this.timer = setTimeout(() => {
      void this.giveBack('timeout');
    }, timeout);
    this.timer.unref?.();
  }

  /** Cancels the timeout and forgets its expiry, e.g. after Give back or a restart. */
  private clearExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.expiresAt = undefined;
  }

  /** The pause question for a request the agent made, quoting its reason as unverified. */
  private agentQuestion(reason: string): string {
    return [
      AGENT_TAKEOVER_PREFIX,
      '',
      'The agent asked for this reason (its words, not verified):',
      reason,
      '',
      this.viewerLine('Open the viewer to take control or give it back'),
    ].join('\n');
  }

  /** The pause question for a turn the owner's Take control interrupted. */
  private ownerQuestion(): string {
    return `${OWNER_TAKEOVER_PREFIX} This turn is paused until you give it back.\n\n${this.viewerLine(
      'Viewer',
    )}`;
  }

  /** The viewer link, or a plain line when the deployment has no viewer. */
  private viewerLine(label: string): string {
    return this.deps.viewerUrl
      ? `${label}: ${this.deps.viewerUrl}`
      : 'The desktop viewer is not available on this deployment.';
  }

  /** What the resumed turn is told after the owner gives the desktop back. */
  private ownerNote(hasImage: boolean): string {
    return hasImage
      ? 'The owner gave the desktop back. The screen may have changed while they had control; the attached screenshot shows it now. Use desktop.inspect for an exact tree.'
      : 'The owner gave the desktop back. The screen may have changed while they had control; take a fresh desktop.inspect snapshot before continuing.';
  }

  /** What the resumed turn is told when the owner-mode timeout returned the desktop. */
  private timeoutNote(hasImage: boolean): string {
    return hasImage
      ? 'The owner did not give the desktop back in time, so the desktop returned to the agent. The screen may have changed; the attached screenshot shows it now.'
      : 'The owner did not give the desktop back in time, so the desktop returned to the agent. The screen may have changed; take a fresh desktop.inspect snapshot before continuing.';
  }

  /** What the resumed turn is told when core restarted while the owner held the desktop. */
  private restartNote(hasImage: boolean): string {
    return hasImage
      ? 'Core restarted while the desktop was with the owner. The desktop is back with the agent; the attached screenshot shows the current screen.'
      : 'Core restarted while the desktop was with the owner. The desktop is back with the agent; take a fresh desktop.inspect snapshot before continuing.';
  }
}
