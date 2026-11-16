import type { OwnerId, SessionId, TurnId } from '../domain/model/ids.js';
import type { Money } from '../domain/model/Money.js';
import type { Transaction } from './Repositories.js';

/** A hold placed before a model request and released when the request ends. */
export interface BudgetReservation {
  id: string;
  ownerId: OwnerId;
  /** A conservative maximum for the request. */
  amount: Money;
  background: boolean;
  sessionId?: SessionId;
  turnId?: TurnId;
  createdAt: Date;
}

export interface BudgetLimits {
  monthly: Money;
  background: Money;
}

export interface ReserveInput {
  ownerId: OwnerId;
  /** Made by the caller; unique. */
  id: string;
  amount: Money;
  background: boolean;
  /** False for an owner-started request: never refused, but its hold still counts in the totals. */
  enforce: boolean;
  /** The start of the budget period. */
  since: Date;
  limits: BudgetLimits;
  now: Date;
  sessionId?: SessionId;
  turnId?: TurnId;
}

export type ReserveOutcome =
  | { reserved: true; reservation: BudgetReservation }
  | { reserved: false; reason: 'monthly_limit' | 'background_allowance' };

/** A price in another currency cannot be compared without a rate we do not have. */
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
  reserve(input: ReserveInput, tx?: Transaction): Promise<ReserveOutcome>;
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
  /** Startup recovery: every open hold belongs to a request that died with the process. */
  releaseAllHeld(at: Date, tx?: Transaction): Promise<number>;
}
