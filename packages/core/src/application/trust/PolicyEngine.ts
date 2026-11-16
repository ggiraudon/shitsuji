import type { TrustBasis, TrustDecision } from '../../ports/Tool.js';
import type { ActionRequest } from './ActionRequest.js';

/**
 * How far the owner trusts the agent outside its workspace, per agent profile (F24).
 * P6 decided the default: auto-accept workspace changes.
 */
export type ApprovalLevel = 'ask' | 'auto-edits' | 'trusted';

/** P6's default; F24 will let a profile choose another. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 'auto-edits';

const none: TrustBasis = { kind: 'none' };

export interface PolicyOptions {
  level?: ApprovalLevel;
}

/**
 * The deterministic part of the trust decision (F11, S34): the effect and the approval level, before
 * any standing rule or model judge. Rules and judgement arrive in S35; until then a `judge` verdict is
 * resolved by the caller (the Trust middleware refuses it, because nothing can judge yet).
 *
 * The order is the one in F11's decision diagram: read and compute run; workspace changes follow the
 * level; anything outside the workspace needs the owner, and payments always ask.
 */
export class PolicyEngine {
  private readonly level: ApprovalLevel;

  constructor(options: PolicyOptions = {}) {
    this.level = options.level ?? DEFAULT_APPROVAL_LEVEL;
  }

  decide(request: ActionRequest): TrustDecision {
    const base = { actionHash: request.hash };

    switch (request.effect) {
      case 'read':
      case 'compute':
        return {
          ...base,
          verdict: 'allow',
          basis: {
            kind: 'policy',
            detail: `${request.effect} actions need no approval`,
          },
        };

      case 'write_local':
        if (this.level === 'ask') {
          return {
            ...base,
            verdict: 'ask',
            basis: none,
            reason: `${request.tool} changes the workspace; the owner's approval level asks first.`,
          };
        }
        return {
          ...base,
          verdict: 'allow',
          basis: {
            kind: 'policy',
            detail: `the approval level (${this.level}) allows workspace changes`,
          },
        };

      case 'payment':
        // Whatever the level, and whatever rules arrive later: money is never spent unasked (P6).
        return {
          ...base,
          verdict: 'ask',
          basis: none,
          reason: `${request.tool} spends money; payments always need the owner's approval.`,
        };

      case 'write_self':
      case 'external':
        if (this.level === 'ask') {
          return {
            ...base,
            verdict: 'ask',
            basis: none,
            reason: `${request.tool} acts outside the workspace; the owner must approve it.`,
          };
        }
        return {
          ...base,
          verdict: 'judge',
          basis: none,
          // P6: at the default level the judge may only allow with a quote; a trusted profile may
          // loosen that for Shitsuji's own state, never for an outside action (F11's level table).
          quoteRequired: this.level === 'auto-edits' || request.effect === 'external',
        };
    }
  }
}
