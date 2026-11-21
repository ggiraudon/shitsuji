import type { OwnerId, SessionId, TurnId } from '../domain/model/ids.js';
import type { Money } from '../domain/model/Money.js';
import type { Transaction } from './Repositories.js';

/**
 * A hold placed before a model request and released when the request ends. It carries a conservative
 * maximum, not the real cost: the usage ledger holds what was actually spent once the request settles.
 */
export interface BudgetReservation {
  /** The hold's id, chosen by the caller; settle and release name it. */
  id: string;
  /** The owner whose month the hold counts against. */
  ownerId: OwnerId;
  /** A conservative maximum for the request. */
  amount: Money;
  /** True when the request is background work, which draws on the background allowance. */
  background: boolean;
  /** The session that made the request, when it came from a turn. */
  sessionId?: SessionId;
  /** The turn that made the request, when it came from a turn. */
  turnId?: TurnId;
  /** When the hold was placed, from the injected clock. */
  createdAt: Date;
}

/** The ceilings for one owner: the month's total spend, and how much of it background work may use. */
export interface BudgetLimits {
  /** Spend allowed in the period, settled plus held, in one currency. */
  monthly: Money;
  /** The part of `monthly` that background work may use; owner messages are never refused. */
  background: Money;
}

/** Everything `reserve` needs: what to hold, for which owner and period, and the limits to check. */
export interface ReserveInput {
  /** The owner whose month is being charged. */
  ownerId: OwnerId;
  /** Made by the caller; unique. Settle and release only touch a held row, so repeating one is safe. */
  id: string;
  /** The conservative maximum to hold, in the limits' currency. */
  amount: Money;
  /** True for background work; the background allowance applies in addition to the monthly cap. */
  background: boolean;
  /** False for an owner-started request: never refused, but its hold still counts in the totals. */
  enforce: boolean;
  /** The start of the budget period. */
  since: Date;
  /** The caps to check against, with their currency. */
  limits: BudgetLimits;
  /** The instant the hold is placed, from the injected clock. */
  now: Date;
  /** The session making the request, when there is one. */
  sessionId?: SessionId;
  /** The turn making the request, when there is one. */
  turnId?: TurnId;
}

/** Either a hold, or the limit that refused it; the caller turns the reason into a `BudgetExceeded`. */
export type ReserveOutcome =
  | {
      /** The hold was placed; `reservation` is stored and counts in the totals. */
      reserved: true;
      /** The stored hold, with the conservative amount. */
      reservation: BudgetReservation;
    }
  | {
      /** The request must not run; the caller decides whether to fail or skip it. */
      reserved: false;
      /** Which cap refused it: the monthly total, or the background allowance. */
      reason: 'monthly_limit' | 'background_allowance';
    };

/**
 * A price in another currency cannot be compared without a rate we do not have. Called by both budget
 * adapters before they touch the stored totals; throws a `TypeError` naming both currencies.
 */
export function assertSameCurrency(amount: Money, limits: BudgetLimits): void {
  if (
    limits.monthly.currency !== amount.currency ||
    limits.background.currency !== amount.currency
  ) {
    throw new TypeError(
      `Budget limits are in ${limits.monthly.currency}, but the request is in ${amount.currency}`,
    );
  }
}

/**
 * Holds for spending made before a model request is sent. The atomic check-and-insert is what makes
 * parallel requests safe: settled spend comes from the usage ledger, open holds cover requests in
 * flight. A hold is released if its request fails, and at startup if the process died (F22, S27).
 */
export interface BudgetStore {
  /** Adds a hold if settled spend plus open holds stays within the limits; never after the request. */
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  /** Marks a hold settled: the usage row now carries the real cost. */
  settle(id: string, at: Date, tx?: Transaction): Promise<void>;
  /** Drops a hold: the request cost nothing. */
  release(id: string, at: Date, tx?: Transaction): Promise<void>;
  /** Open holds since `since`, in `currency` (optionally only background ones). */
  heldSince(
    ownerId: OwnerId,
    since: Date,
    currency: string,
    background?: boolean,
    tx?: Transaction,
  ): Promise<Money>;
  /** Spend already recorded in the usage ledger (optionally only background ones). */
  spentSince(
    ownerId: OwnerId,
    since: Date,
    currency: string,
    background?: boolean,
    tx?: Transaction,
  ): Promise<Money>;
  /** Settled spend plus open holds for one session since `since` (F22 check-in). */
  sessionSpentSince(
    ownerId: OwnerId,
    sessionId: SessionId,
    since: Date,
    currency: string,
    tx?: Transaction,
  ): Promise<Money>;
  /** Startup recovery: every open hold belongs to a request that died with the process. */
  releaseAllHeld(at: Date): Promise<number>;
}
