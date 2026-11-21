import type { TrustDecision } from '../../ports/Tool.js';
import type { ActionRequest } from './ActionRequest.js';
import { PolicyEngine } from './PolicyEngine.js';

/** What a trust check needs from the call: which turn it is, and how to stop it. */
export interface TrustCheck {
  /** The turn the action belongs to; its owner messages are the only authority. */
  turnId: string;
  /** The session whose transcript supplies the owner's words. */
  sessionId: string;
  /** Aborted on Stop; a judgement must not outlive its turn. */
  signal: AbortSignal;
  /** Background work cannot wait for the owner indefinitely (#51). */
  background?: boolean;
}

/**
 * What the Trust middleware needs (F11): decide one exact action. It may answer asynchronously,
 * because the judge is a model call.
 */
export interface TrustPolicy {
  /** The verdict for one action, with its basis; must fail safe to `ask`, never to `allow`. */
  decide(request: ActionRequest, check: TrustCheck): TrustDecision | Promise<TrustDecision>;
}

/**
 * The deterministic engine alone, for graphs without a judge (most unit tests): a `judge` verdict
 * reaches the middleware unresolved and is refused there. Production uses TrustService.
 */
export class PolicyOnlyTrust implements TrustPolicy {
  constructor(
    /** The engine to consult; a default one when the test has no rules. */
    private readonly engine: PolicyEngine = new PolicyEngine(),
  ) {}

  /** The engine's verdict, without a judge or the owner. */
  decide(request: ActionRequest): TrustDecision {
    return this.engine.decide(request);
  }
}
