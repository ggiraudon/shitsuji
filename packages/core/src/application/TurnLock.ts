import { ShitsujiError } from '../domain/errors.js';
import type { TurnId } from '../domain/model/ids.js';
import type { Repositories, Transaction } from '../ports/Repositories.js';

/** The turn was stopped, finished or failed before this write could happen. */
export class TurnNoLongerActive extends ShitsujiError {
  /** The subclass name, as `Error.name` and `toJSON` report it. */
  override readonly name = 'TurnNoLongerActive';
  constructor(turnId: TurnId, status: string) {
    super('turn_not_active', `Turn ${turnId} is ${status}, so this write was refused`, {
      turnId,
      status,
    });
  }
}

/**
 * Fences every write a turn's tools make (memory, schedules, approvals…): the write runs only while
 * the turn is still `running`, inside one transaction that holds the turn's row lock. After Stop, a
 * slow tool cannot write late. (F02, idea from nod's withTurnLock.)
 */
export class TurnLock {
  constructor(
    /** Storage, for the unit of work and the row lock. */
    private readonly repos: Repositories,
  ) {}

  /** Runs `fn` in a transaction that holds the turn's row lock, or throws `TurnNoLongerActive`. */
  async write<T>(turnId: TurnId, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.repos.uow.run(async (tx) => {
      const turn = await this.repos.turns.getForUpdate(turnId, tx);
      if (!turn) throw new TurnNoLongerActive(turnId, 'missing');
      if (turn.status !== 'running') throw new TurnNoLongerActive(turnId, turn.status);
      return fn(tx);
    });
  }
}
