import { InvalidTransition } from '../errors.js';
import type { ApprovalId, OwnerId, SessionId, TurnId } from './ids.js';

/**
 * The approval's life (F11, S36): asking, the owner's answer, and what became of the action. An
 * approved action runs at most once; a failed or interrupted one becomes `uncertain` and is never
 * retried automatically.
 */
export type ApprovalStatus =
  'pending' | 'approved' | 'declined' | 'expired' | 'executed' | 'uncertain';

const ALLOWED: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ['approved', 'declined', 'expired'],
  approved: ['executed', 'uncertain'],
  declined: [],
  expired: [],
  executed: [],
  uncertain: [],
};

export interface ApprovalProps {
  id: ApprovalId;
  ownerId: OwnerId;
  turnId: TurnId;
  sessionId: SessionId;
  /** The exact action: tool, effect, target, arguments and the hash an approval is bound to. */
  tool: string;
  effect: string;
  target: string;
  actionHash: string;
  /** Redacted, shortened arguments, for the card and the audit trail. */
  arguments: Record<string, unknown>;
  /** One line the owner reads before deciding. */
  summary: string;
  status: ApprovalStatus;
  /** Why it was asked: the engine's reason, or the judge's. */
  reason?: string;
  createdAt: Date;
  /** When the owner approved or declined it. */
  decidedAt?: Date;
  /** When it expired, ran, or became uncertain. */
  endedAt?: Date;
}

/**
 * One request to act outside the workspace, waiting for the owner (F11, S36). The arguments and their
 * hash are fixed when it is created: an approval for one action never covers another, even with the
 * same tool name.
 */
export class Approval {
  private constructor(private props: ApprovalProps) {}

  static request(props: Omit<ApprovalProps, 'status'>): Approval {
    return new Approval({ ...props, status: 'pending' });
  }

  /** Rebuilds an approval from storage, in whatever status it was saved. */
  static restore(props: ApprovalProps): Approval {
    return new Approval({ ...props });
  }

  static canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
    return ALLOWED[from].includes(to);
  }

  get id(): ApprovalId {
    return this.props.id;
  }
  get status(): ApprovalStatus {
    return this.props.status;
  }
  get actionHash(): string {
    return this.props.actionHash;
  }
  get turnId(): TurnId {
    return this.props.turnId;
  }
  get sessionId(): SessionId {
    return this.props.sessionId;
  }
  get tool(): string {
    return this.props.tool;
  }
  /** Still waiting, or approved and not yet run. */
  get isOpen(): boolean {
    return this.props.status === 'pending' || this.props.status === 'approved';
  }

  approve(at: Date): void {
    this.transition('approved');
    this.props.decidedAt = at;
  }

  decline(at: Date): void {
    this.transition('declined');
    this.props.decidedAt = at;
  }

  expire(at: Date): void {
    this.transition('expired');
    this.props.endedAt = at;
  }

  execute(at: Date): void {
    this.transition('executed');
    this.props.endedAt = at;
  }

  /** The action may have run: a failure, a stop, or a crash while it was running. */
  uncertain(at: Date): void {
    this.transition('uncertain');
    this.props.endedAt = at;
  }

  toProps(): ApprovalProps {
    return { ...this.props, arguments: { ...this.props.arguments } };
  }

  private transition(to: ApprovalStatus): void {
    if (!Approval.canTransition(this.props.status, to)) {
      throw new InvalidTransition('Approval', this.props.status, to);
    }
    this.props.status = to;
  }
}
