import { NotFound } from '../../domain/errors.js';
import { Approval, type ApprovalStatus } from '../../domain/model/Approval.js';
import {
  newId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../domain/model/ids.js';
import type { Clock } from '../../ports/Clock.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { Logger } from '../../ports/Logger.js';
import type { ApprovalRepository } from '../../ports/Repositories.js';
import type { ActionRequest } from './ActionRequest.js';

/** What an approval card is about (F11, S36). */
export interface ApprovalInput {
  ownerId: OwnerId;
  turnId: TurnId;
  sessionId: SessionId;
  action: ActionRequest;
  /** Why the policy or the judge asked. */
  reason?: string;
}

export interface ApprovalServiceDeps {
  approvals: ApprovalRepository;
  events: EventBus;
  clock: Clock;
  log: Logger;
}

/**
 * The approval state machine in use (F11, S36): creates a pending approval bound to the action's
 * hash, publishes it as a card, and waits for the owner or for the turn's Stop. The owner's answer is
 * a compare-and-set, so approving twice runs the action once; an approved action that fails or is
 * interrupted ends `uncertain`, never retried.
 */
export class ApprovalService {
  /** One resolver per approval waiting in this process. */
  private readonly waiting = new Map<string, (approval: Approval) => void>();

  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Asks the owner and waits. The card is durable before it is published, so a restart can show it as
   * expired rather than losing it. Stop expires it and wakes the caller.
   */
  async request(input: ApprovalInput, signal: AbortSignal): Promise<Approval> {
    const action = input.action;
    const pending = Approval.request({
      id: newId<ApprovalId>(),
      ownerId: input.ownerId,
      turnId: input.turnId,
      sessionId: input.sessionId,
      tool: action.tool,
      effect: action.effect,
      target: action.target,
      actionHash: action.hash,
      arguments: storable(action.arguments),
      summary: summaryOf(action),
      ...(input.reason && { reason: input.reason }),
      createdAt: this.deps.clock.now(),
    });
    await this.deps.approvals.insert(pending);

    const decided = new Promise<Approval>((resolve) => this.waiting.set(pending.id, resolve));
    const onAbort = () => void this.expire(pending.id, 'the turn stopped');
    if (signal.aborted) await this.expire(pending.id, 'the turn stopped');
    else signal.addEventListener('abort', onAbort, { once: true });

    this.deps.events.publish('approval.requested', {
      approvalId: pending.id,
      turnId: pending.turnId,
      sessionId: input.sessionId,
      tool: pending.tool,
      effect: action.effect,
      summary: summaryOf(action),
      actionHash: action.hash,
    });
    this.deps.log.info('Waiting for the owner to approve an action', {
      approvalId: pending.id,
      tool: pending.tool,
      effect: action.effect,
    });

    try {
      return await decided;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.waiting.delete(pending.id);
    }
  }

  /**
   * The owner's answer. Only a pending approval changes; a second answer returns the current state
   * (so a card pressed twice is harmless, and the action runner sees one approval).
   */
  async resolve(id: ApprovalId, answer: 'approve' | 'decline'): Promise<Approval> {
    const current = await this.load(id);
    if (current.status !== 'pending') return current;

    const next = Approval.restore(current.toProps());
    if (answer === 'approve') next.approve(this.deps.clock.now());
    else next.decline(this.deps.clock.now());
    if (await this.deps.approvals.update(next, 'pending')) {
      this.publish(next);
      this.wake(next);
      return next;
    }
    // Someone else answered first (or Stop expired it): report the state that won.
    return this.load(id);
  }

  /** The owner's answer never came: the turn stopped, or core restarted. */
  async expire(id: ApprovalId, why: string): Promise<Approval | undefined> {
    const current = await this.deps.approvals.get(id);
    if (!current || current.status !== 'pending') return current;

    const next = Approval.restore(current.toProps());
    next.expire(this.deps.clock.now());
    if (!(await this.deps.approvals.update(next, 'pending'))) return undefined;
    this.deps.log.info('Approval expired', { approvalId: id, reason: why });
    this.publish(next);
    this.wake(next);
    return next;
  }

  /** Records what became of an approved action: it ran, or it may have run. */
  async finish(id: ApprovalId, succeeded: boolean): Promise<Approval | undefined> {
    const current = await this.deps.approvals.get(id);
    if (!current || current.status !== 'approved') return current;

    const next = Approval.restore(current.toProps());
    const now = this.deps.clock.now();
    if (succeeded) next.execute(now);
    else next.uncertain(now);
    if (!(await this.deps.approvals.update(next, 'approved'))) return this.deps.approvals.get(id);
    this.publish(next);
    return next;
  }

  /**
   * An answer already recorded for this exact action in this turn, if any (F11's fence): asking
   * twice for the same thing in one request would only annoy the owner.
   */
  async decidedFor(turnId: TurnId, actionHash: string): Promise<Approval | undefined> {
    const inTurn = await this.deps.approvals.list({ turnId });
    return inTurn.find((a) => a.actionHash === actionHash && a.status !== 'pending');
  }

  private async load(id: ApprovalId): Promise<Approval> {
    const approval = await this.deps.approvals.get(id);
    if (!approval) throw new NotFound('Approval', id);
    return approval;
  }

  private publish(approval: Approval): void {
    this.deps.events.publish('approval.resolved', {
      approvalId: approval.id,
      turnId: approval.turnId,
      sessionId: approval.toProps().sessionId,
      status: approval.status as Exclude<ApprovalStatus, 'pending'>,
    });
  }

  private wake(approval: Approval): void {
    const resolve = this.waiting.get(approval.id);
    if (!resolve) return;
    this.waiting.delete(approval.id);
    resolve(approval);
  }
}

/** One line for the card: what would run, with a short argument preview. */
export function summaryOf(action: ActionRequest): string {
  const args = JSON.stringify(action.arguments);
  const preview = args.length > 160 ? `${args.slice(0, 160)}…` : args;
  return `${action.tool} (${action.effect}) ${preview}`;
}

/** Keeps strings in the stored copy short; the hash is what binds the exact arguments. */
function storable(args: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = clip(value, depth);
  }
  return out;
}

function clip(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value) && depth < 4) return value.slice(0, 20).map((v) => clip(v, depth + 1));
  if (value !== null && typeof value === 'object' && depth < 4) {
    return storable(value as Record<string, unknown>, depth + 1);
  }
  return value;
}
