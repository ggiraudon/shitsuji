import { serializeError } from '../../domain/errors.js';
import { asId, type SessionId } from '../../domain/model/ids.js';
import type { Logger } from '../../ports/Logger.js';
import type { MessageRepository } from '../../ports/Repositories.js';
import type { TrustBasis, TrustDecision } from '../../ports/Tool.js';
import { AuthorityResolver, type Authority } from './Authority.js';
import type { ActionRequest } from './ActionRequest.js';
import type { PolicyEngine } from './PolicyEngine.js';
import { QuoteVerifier } from './QuoteVerifier.js';
import type { StandingRule } from './StandingRule.js';
import type { TrustJudge } from './TrustJudge.js';
import type { TrustCheck, TrustPolicy } from './TrustPolicy.js';

const none: TrustBasis = { kind: 'none' };

/** Where the owner's words come from. The server reads the session's transcript. */
export interface AuthoritySource {
  forTurn(check: TrustCheck): Promise<Authority>;
}

/** Reads one session's transcript and keeps the owner's own words (F11, S35). */
export class SessionAuthority implements AuthoritySource {
  constructor(
    private readonly messages: MessageRepository,
    private readonly resolver: AuthorityResolver = new AuthorityResolver(),
    /** Standing rules, when F16 stores them; none yet. */
    private readonly rules: () => Promise<readonly StandingRule[]> = async () => [],
  ) {}

  async forTurn(check: TrustCheck): Promise<Authority> {
    const messages = await this.messages.listBySession(asId<SessionId>(check.sessionId), {
      limit: 200,
    });
    return this.resolver.resolve({ messages, rules: await this.rules() });
  }
}

export interface TrustServiceDeps {
  engine: PolicyEngine;
  authority: AuthoritySource;
  judge?: TrustJudge;
  log: Logger;
}

/**
 * The trust decision for one action (F11, S35): the deterministic engine answers most calls; a
 * `judge` verdict goes to the model judge with the owner's words, and its allow stands only if
 * QuoteVerifier finds the quote. Any failure on the way — the transcript, the judge, a bad quote —
 * becomes ask, never allow.
 */
export class TrustService implements TrustPolicy {
  private readonly verifier = new QuoteVerifier();

  constructor(private readonly deps: TrustServiceDeps) {}

  async decide(request: ActionRequest, check: TrustCheck): Promise<TrustDecision> {
    let authority: Authority;
    try {
      authority = await this.deps.authority.forTurn(check);
    } catch (error) {
      this.deps.log.error('Could not read the authority for a trust decision', {
        tool: request.tool,
        error: serializeError(error),
      });
      return this.record(request, {
        verdict: 'ask',
        basis: none,
        reason: "The owner's words could not be read, so the owner is asked.",
        actionHash: request.hash,
      });
    }

    const decided = this.deps.engine.decide(request, authority.rules);
    if (decided.verdict !== 'judge') return this.record(request, decided);

    const judged = await this.judge(request, authority, decided, check);
    return this.record(request, judged);
  }

  private async judge(
    request: ActionRequest,
    authority: Authority,
    engine: TrustDecision,
    check: TrustCheck,
  ): Promise<TrustDecision> {
    if (!this.deps.judge) {
      return {
        verdict: 'ask',
        basis: none,
        reason: 'No trust judge is configured, so the owner is asked.',
        actionHash: request.hash,
      };
    }
    const judged = await this.deps.judge.judge(request, authority, {
      ...(engine.quoteRequired !== undefined && { quoteRequired: engine.quoteRequired }),
      signal: check.signal,
      turnId: check.turnId,
      sessionId: check.sessionId,
    });

    if (judged.verdict !== 'allow') {
      return {
        verdict: judged.verdict,
        basis: none,
        reason:
          judged.reason ??
          (judged.verdict === 'deny'
            ? 'The trust judgement refused the action.'
            : 'The trust judgement asks the owner.'),
        actionHash: request.hash,
      };
    }

    if (judged.quote && this.verifier.verify(judged.quote, authority)) {
      return {
        verdict: 'allow',
        basis: { kind: 'quote', detail: judged.quote },
        actionHash: request.hash,
      };
    }
    if (!engine.quoteRequired && !judged.quote) {
      // A trusted profile may let a change to Shitsuji itself run on the judge's word alone.
      return {
        verdict: 'allow',
        basis: { kind: 'policy', detail: 'the trust judge allowed it without a quote' },
        actionHash: request.hash,
      };
    }
    return {
      verdict: 'ask',
      basis: none,
      reason: judged.quote
        ? "The quote the trust judgement allowed with is not the owner's words, so the owner is asked."
        : "The trust judgement allowed the action without the owner's words, so the owner is asked.",
      actionHash: request.hash,
    };
  }

  /** Logs every decision with its basis; the receipt keeps it too (F11, S22). */
  private record(request: ActionRequest, decision: TrustDecision): TrustDecision {
    const context = {
      tool: request.tool,
      verdict: decision.verdict,
      basis: decision.basis.kind,
      ...(decision.actionHash && { actionHash: decision.actionHash }),
    };
    if (decision.verdict === 'allow') this.deps.log.debug('Trust decision', context);
    else this.deps.log.info('Trust decision', { ...context, reason: decision.reason });
    return decision;
  }
}
