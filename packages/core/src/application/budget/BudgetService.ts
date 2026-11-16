import { BudgetExceeded, serializeError } from '../../domain/errors.js';
import { newId, type OwnerId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import type { Money } from '../../domain/model/Money.js';
import type { BudgetLimits, BudgetReservation, BudgetStore } from '../../ports/BudgetStore.js';
import type { Clock } from '../../ports/Clock.js';
import type { Logger } from '../../ports/Logger.js';

export interface BudgetServiceDeps {
  store: BudgetStore;
  ownerId: OwnerId;
  clock: Clock;
  log: Logger;
  limits: BudgetLimits;
}

/** What a model request is for: whose budget covers it and where it belongs. */
export interface BudgetScope {
  /** True when no owner message started this request (tasks, schedules, events). */
  background: boolean;
  sessionId?: SessionId;
  turnId?: TurnId;
}

/** The start of the calendar month in UTC: a stable period without time-zone or DST edges. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Spending limits around every model request (F22, S27). It reserves a conservative maximum before
 * the request is sent and settles the real cost after, so parallel requests cannot overspend.
 *
 * - Past the monthly limit, an owner-started request still runs; background work is refused with a
 *   clear reason.
 * - Background work must also fit the background allowance, and refuses a request whose price is
 *   unknown rather than spending blind.
 * - Owner-started work with an unknown price is allowed (the total is then a lower bound) and its
 *   hold only counts towards the totals.
 */
export class BudgetService {
  private warnedUnknownPrice = false;

  constructor(private readonly deps: BudgetServiceDeps) {}

  /** Holds a conservative maximum for this request, or throws BudgetExceeded before it is sent. */
  async reserve(
    scope: BudgetScope,
    estimate: Money | undefined,
  ): Promise<BudgetReservation | undefined> {
    const now = this.deps.clock.now();
    const amount = this.usable(estimate);
    if (!amount) {
      if (scope.background) {
        throw new BudgetExceeded(
          'This background model call has no known price, so the background allowance cannot cover ' +
            'it. Add the model to models.catalog with a price.',
          { reason: 'unknown_price' },
        );
      }
      this.warnUnknownPrice();
      return undefined;
    }
    const outcome = await this.deps.store.reserve({
      ownerId: this.deps.ownerId,
      id: newId(),
      amount,
      background: scope.background,
      // Only background work is refused; the owner can always keep talking.
      enforce: scope.background,
      since: monthStart(now),
      limits: this.deps.limits,
      now,
      ...(scope.sessionId && { sessionId: scope.sessionId }),
      ...(scope.turnId && { turnId: scope.turnId }),
    });
    if (outcome.reserved) return outcome.reservation;

    const limit =
      outcome.reason === 'monthly_limit' ? this.deps.limits.monthly : this.deps.limits.background;
    const spent = await this.spentThisMonth(scope.background);
    throw new BudgetExceeded(
      outcome.reason === 'monthly_limit'
        ? `The monthly spending limit of ${limit.toString()} is reached (${spent.toString()} spent ` +
            `or reserved). Only your own messages run until next month.`
        : `The background allowance of ${limit.toString()} is reached (${spent.toString()} spent ` +
            `or reserved). Background work is paused until next month.`,
      {
        reason: outcome.reason,
        limit: limit.toString(),
        spent: spent.toString(),
        currency: limit.currency,
      },
    );
  }

  /** Replaces a hold with the real cost. The usage row was already written; failures are logged. */
  async settle(
    reservation: BudgetReservation | undefined,
    actual: Money | undefined,
  ): Promise<void> {
    if (!reservation) return;
    if (actual && actual.compare(reservation.amount) > 0) {
      this.deps.log.warn('A model request cost more than its reservation', {
        reserved: reservation.amount.toString(),
        actual: actual.toString(),
      });
    }
    try {
      await this.deps.store.settle(reservation.id, this.deps.clock.now());
    } catch (error) {
      this.deps.log.error('Could not settle a budget hold', {
        reservationId: reservation.id,
        error: serializeError(error),
      });
    }
  }

  /** Drops a hold when the request cost nothing (failed, stopped, or never completed). */
  async release(reservation: BudgetReservation | undefined): Promise<void> {
    if (!reservation) return;
    try {
      await this.deps.store.release(reservation.id, this.deps.clock.now());
    } catch (error) {
      this.deps.log.error('Could not release a budget hold', {
        reservationId: reservation.id,
        error: serializeError(error),
      });
    }
  }

  /** Settled spend plus open holds since the start of the month. */
  async spentThisMonth(background?: boolean): Promise<Money> {
    const { store, ownerId, clock } = this.deps;
    const currency = this.deps.limits.monthly.currency;
    const since = monthStart(clock.now());
    const spent = await store.spentSince(ownerId, since, currency, background);
    const held = await store.heldSince(ownerId, since, currency, background);
    return spent.plus(held);
  }

  /** A price in another currency is as good as none: there is no rate to compare it with. */
  private usable(estimate: Money | undefined): Money | undefined {
    if (!estimate) return undefined;
    if (estimate.currency !== this.deps.limits.monthly.currency) {
      this.warnUnknownPrice(estimate);
      return undefined;
    }
    return estimate;
  }

  private warnUnknownPrice(estimate?: Money): void {
    if (this.warnedUnknownPrice) return;
    this.warnedUnknownPrice = true;
    this.deps.log.warn(
      'A model has no usable price; owner requests run without a reservation, so the monthly total is ' +
        'a lower bound',
      { currency: this.deps.limits.monthly.currency, priced: estimate?.currency },
    );
  }
}
