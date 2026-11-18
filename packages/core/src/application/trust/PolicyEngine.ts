import type { TrustBasis, TrustDecision } from '../../ports/Tool.js';
import type { ActionRequest } from './ActionRequest.js';
import { strongestRule, type StandingRule } from './StandingRule.js';

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
  /** Standing rules from the config (`trust.rules`); call-time rules are added to them. */
  rules?: readonly StandingRule[];
}

/**
 * The deterministic part of the trust decision (F11, S34): the effect and the approval level, before
 * any standing rule or model judge. Rules and judgement arrive in S35; until then a `judge` verdict is
 * resolved by the caller (the Trust middleware refuses it, because nothing can judge yet).
 *
 * The order is the one in F11's decision diagram: read and compute run; workspace changes follow the
 * level; anything outside the workspace checks the owner's standing rules first, then goes to the
 * judge (S35). Money always asks.
 */
export class PolicyEngine {
  private readonly level: ApprovalLevel;
  private readonly rules: readonly StandingRule[];

  constructor(options: PolicyOptions = {}) {
    this.level = options.level ?? DEFAULT_APPROVAL_LEVEL;
    this.rules = options.rules ?? [];
  }

  /** `rules` are the owner's standing rules for this action (F11; the authority arrives in S35). */
  decide(request: ActionRequest, rules: readonly StandingRule[] = []): TrustDecision {
    const base = { actionHash: request.hash };
    const allRules = [...this.rules, ...rules];

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

      case 'payment': {
        // Whatever the level, and whichever rule allows: money is never spent unasked (P6).
        const rule = strongestRule(allRules, request);
        if (rule?.action === 'deny') return denyByRule(rule, base);
        if (rule?.action === 'ask') return askByRule(rule, base);
        return {
          ...base,
          verdict: 'ask',
          basis: none,
          reason: `${request.tool} spends money; payments always need the owner's approval.`,
        };
      }

      case 'write_self':
      case 'external': {
        const rule = strongestRule(allRules, request);
        if (rule?.action === 'deny') return denyByRule(rule, base);
        if (rule?.action === 'ask') return askByRule(rule, base);
        // A "go ahead" rule covers outside actions, never a change to Shitsuji itself (F11).
        if (rule?.action === 'allow' && request.effect !== 'write_self') {
          return {
            ...base,
            verdict: 'allow',
            basis: {
              kind: 'rule',
              detail: rule.detail ?? `a standing rule allows ${rule.tool}`,
            },
          };
        }
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
}

function denyByRule(rule: StandingRule, base: { actionHash: string }): TrustDecision {
  return {
    ...base,
    verdict: 'deny',
    basis: none,
    reason: `A standing rule forbids it${wordsOf(rule)}.`,
  };
}

function askByRule(rule: StandingRule, base: { actionHash: string }): TrustDecision {
  return {
    ...base,
    verdict: 'ask',
    basis: none,
    reason: `A standing rule says to ask first${wordsOf(rule)}.`,
  };
}

/** The owner's words when the rule kept them, else the pattern it matches. */
function wordsOf(rule: StandingRule): string {
  return rule.detail ? `: "${rule.detail}"` : ` (${rule.tool})`;
}
