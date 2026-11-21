import { serializeError } from '../domain/errors.js';
import { newId } from '../domain/model/ids.js';
import { Approval } from '../domain/model/Approval.js';
import type { Turn } from '../domain/model/Turn.js';
import type { Clock } from '../ports/Clock.js';
import type { Logger } from '../ports/Logger.js';
import type { Repositories } from '../ports/Repositories.js';

/** The reason stored on turns a crash left `running`; the next turn reads it as a system note. */
export const INTERRUPTED = 'interrupted';

/**
 * Runs once at startup, before anything else. Turns left `running` by a crash become
 * `failed(interrupted)`. They are never retried, because a tool may already have acted outside;
 * instead the session gets a system note, so the next turn knows what happened (F02).
 * Assumes a single core process: another live core's running turns would also be failed.
 */
export class StartupRecovery {
  constructor(
    /** Storage for turns, sessions, messages and approvals; recovery writes through it. */
    private readonly repos: Repositories,
    /** Injected clock for the failed and expired timestamps. */
    private readonly clock: Clock,
    /** Structured logger; every recovered turn and approval is reported here. */
    private readonly log: Logger,
  ) {}

  /**
   * Marks the previous process's `running` turns failed and settles the approvals it left open. Returns
   * the turns it recovered; a failure on one row is logged and does not stop the others.
   */
  async run(): Promise<Turn[]> {
    // A hold from the previous run belongs to a request whose process died with it.
    try {
      const released = await this.repos.budget.releaseAllHeld(this.clock.now());
      if (released > 0) {
        this.log.warn('Released budget holds left by the previous run', { count: released });
      }
    } catch (error) {
      this.log.error('Could not release budget holds', { error: serializeError(error) });
    }

    const recovered: Turn[] = [];
    for (const turn of await this.repos.turns.listByStatus('running')) {
      try {
        const done = await this.repos.uow.run(async (tx) => {
          turn.fail(this.clock.now(), INTERRUPTED);
          if (!(await this.repos.turns.update(turn, 'running', tx))) return false;
          const session = await this.repos.sessions.get(turn.sessionId, tx);
          if (session) {
            await this.repos.messages.append(
              {
                id: newId(),
                threadId: session.threadId,
                sessionId: session.id,
                turnId: turn.id,
                role: 'system',
                author: 'system',
                parts: [
                  {
                    type: 'text',
                    text:
                      'Note: your previous turn was interrupted by a restart before it finished. ' +
                      'Tools it called may have partly run. Check before repeating any action.',
                  },
                ],
                withdrawn: false,
                createdAt: this.clock.now(),
              },
              tx,
            );
          }
          return true;
        });
        if (done) recovered.push(turn);
      } catch (error) {
        this.log.error('Could not recover turn', { turnId: turn.id, error: serializeError(error) });
      }
    }
    if (recovered.length) {
      this.log.warn('Interrupted turns marked failed', { turns: recovered.map((t) => t.id) });
    }
    await this.recoverApprovals();
    return recovered;
  }

  /**
   * Approvals left open by a crash (F11, S36): nobody can answer a pending one, and an approved one
   * may already have run. Neither is retried; an approved action becomes `uncertain` so the next turn
   * knows to check.
   */
  private async recoverApprovals(): Promise<void> {
    try {
      const open = await this.repos.approvals.list({ status: ['pending', 'approved'] });
      if (!open.length) return;
      let expired = 0;
      let uncertain = 0;
      for (const approval of open) {
        const from = approval.status;
        const next = Approval.restore(approval.toProps());
        if (from === 'pending') next.expire(this.clock.now());
        else next.uncertain(this.clock.now());
        if (await this.repos.approvals.update(next, from)) {
          if (from === 'pending') expired++;
          else uncertain++;
        }
      }
      if (expired) this.log.warn('Expired approvals left by the previous run', { count: expired });
      if (uncertain) {
        this.log.warn('Approved actions may have run before the restart', { count: uncertain });
      }
    } catch (error) {
      this.log.error('Could not recover approvals', { error: serializeError(error) });
    }
  }
}
