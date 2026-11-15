import { serializeError } from '../domain/errors.js';
import { newId } from '../domain/model/ids.js';
import type { Turn } from '../domain/model/Turn.js';
import type { Clock } from '../ports/Clock.js';
import type { Logger } from '../ports/Logger.js';
import type { Repositories } from '../ports/Repositories.js';

export const INTERRUPTED = 'interrupted';

/**
 * Runs once at startup, before anything else. Turns left `running` by a crash become
 * `failed(interrupted)`. They are never retried, because a tool may already have acted outside;
 * instead the session gets a system note, so the next turn knows what happened (F02).
 * Assumes a single core process: another live core's running turns would also be failed.
 */
export class StartupRecovery {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async run(): Promise<Turn[]> {
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
    return recovered;
  }
}
