import { InvalidTransition } from '../errors.js';
import type { ApprovalId, OwnerId, SessionId, TurnId } from './ids.js';

/**
 * The approval's life (F11, S36): asking, the owner's answer, and what became of the action. An
 * approved action runs at most once; a failed or interrupted one becomes `uncertain` and is never
 * retried automatically. `pending → approved | declined | expired`, `approved → executed | uncertain`,
 * and nothing leaves `declined`, `expired`, `executed` or `uncertain`.
 */
export type ApprovalStatus =
  'pending' | 'approved' | 'declined' | 'expired' | 'executed' | 'uncertain';

/** The status table behind {@link Approval.canTransition}. */
const ALLOWED: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ['approved', 'declined', 'expired'],
  approved: ['executed', 'uncertain'],
  declined: [],
  expired: [],
  executed: [],
  uncertain: [],
};

/** An approval as stored: plain data, copied in and out of the entity by {@link Approval.toProps}. */
export interface ApprovalProps {
  /** The card's id; the button payload and the API both name the approval by it. */
  id: ApprovalId;
  /** The owner who must answer; one per install today. */
  ownerId: OwnerId;
  /** The turn that is blocked waiting for this answer; its reply channel gets the card. */
  turnId: TurnId;
  /** The session whose pending cards a new message supersedes. */
  sessionId: SessionId;
  /** The exact action: tool, effect, target, arguments and the hash an approval is bound to. */
  tool: string;
  /** The tool's `ToolEffect`, as a string so the domain stays independent of the port. */
  effect: string;
  /** Where the action runs: `core`, `workspace`, `desktop` or `mcp`. */
  target: string;
  /** Binds the approval to one exact action; see {@link Approval.actionHash}. */
  actionHash: string;
  /**
   * Redacted, shortened arguments, for the card and the audit trail. They are a preview, not a copy
   * of the action: `actionHash` is what binds the approval, so the action is re-derived from the turn,
   * never rebuilt from these values.
   */
  arguments: Record<string, unknown>;
  /** One line the owner reads before deciding. */
  summary: string;
  /** Where it is in the state machine; see {@link ApprovalStatus}. */
  status: ApprovalStatus;
  /** Why it was asked: the engine's reason, or the judge's. */
  reason?: string;
  /** When the request was stored, before the card was published. */
  createdAt: Date;
  /** When the owner approved or declined it. */
  decidedAt?: Date;
  /** When it expired, ran, or became uncertain. */
  endedAt?: Date;
}

/**
 * One request to act outside the workspace, waiting for the owner (F11, S36). The arguments and their
 * hash are fixed when it is created: an approval for one action never covers another, even with the
 * same tool name. A blocked turn asks through `ApprovalService`, which stores the card before
 * publishing it and applies the owner's answer with compare-and-set; only a `pending` card can change,
 * so a card pressed twice is harmless.
 *
 * The class mutates in memory only. Persisting it, and deciding whether the race was lost, is
 * `ApprovalRepository.update`'s compare-and-set; an illegal move here throws `InvalidTransition`.
 */
export class Approval {
  private constructor(
    /** The mutable state; `toProps` hands out a copy. */
    private props: ApprovalProps,
  ) {}

  /** A new `pending` approval; the card is not published yet (the service does that after storing it). */
  static request(props: Omit<ApprovalProps, 'status'>): Approval {
    return new Approval({ ...props, status: 'pending' });
  }

  /** Rebuilds an approval from storage, in whatever status it was saved. */
  static restore(props: ApprovalProps): Approval {
    return new Approval({ ...props });
  }

  /** Whether the state machine allows this move, for callers that want to check before trying. */
  static canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
    return ALLOWED[from].includes(to);
  }

  /** The approval's id, as the card and the resolve call use it. */
  get id(): ApprovalId {
    return this.props.id;
  }
  /** Where the approval is in its state machine; see {@link ApprovalStatus}. */
  get status(): ApprovalStatus {
    return this.props.status;
  }
  /** The exact action this approval covers; a different hash needs a new card. */
  get actionHash(): string {
    return this.props.actionHash;
  }
  /** The turn waiting for this answer. */
  get turnId(): TurnId {
    return this.props.turnId;
  }
  /** The session whose new message supersedes the card. */
  get sessionId(): SessionId {
    return this.props.sessionId;
  }
  /** The tool the action calls, for the card and the logs. */
  get tool(): string {
    return this.props.tool;
  }
  /** Still waiting, or approved and not yet run. */
  get isOpen(): boolean {
    return this.props.status === 'pending' || this.props.status === 'approved';
  }

  /** The owner said yes. The action still has to be run and then reported as executed or uncertain. */
  approve(at: Date): void {
    this.transition('approved');
    this.props.decidedAt = at;
  }

  /** The owner said no. The action never runs, and the agent may not ask the same thing in this turn. */
  decline(at: Date): void {
    this.transition('declined');
    this.props.decidedAt = at;
  }

  /**
   * Nobody answered: the turn stopped, a new owner message superseded the card, or the work could not
   * wait. The action does not run.
   */
  expire(at: Date): void {
    this.transition('expired');
    this.props.endedAt = at;
  }

  /** The approved action ran to completion. At most one `execute` per approval. */
  execute(at: Date): void {
    this.transition('executed');
    this.props.endedAt = at;
  }

  /**
   * The action may have run: a failure, a stop, or a crash while it was running. It is never retried,
   * because a second attempt could duplicate the outside effect.
   */
  uncertain(at: Date): void {
    this.transition('uncertain');
    this.props.endedAt = at;
  }

  /** A plain copy for storage, with the arguments copied too so a caller cannot edit the row. */
  toProps(): ApprovalProps {
    return { ...this.props, arguments: { ...this.props.arguments } };
  }

  /** Throws {@link InvalidTransition} when the move is not allowed from the current status. */
  private transition(to: ApprovalStatus): void {
    if (!Approval.canTransition(this.props.status, to)) {
      throw new InvalidTransition('Approval', this.props.status, to);
    }
    this.props.status = to;
  }
}
