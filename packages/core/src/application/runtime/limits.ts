import type { SessionKind } from '../../domain/model/Session.js';

/** Model calls per turn before it is stopped as a runaway, by session kind (decision Q5). */
export type StepLimits = Record<SessionKind, number>;

/** The defaults `TurnRunner` merges with `AgentOptions.limits`; one number per session kind. */
export const DEFAULT_STEP_LIMITS: StepLimits = {
  chat: 40,
  task: 200,
  helper: 30,
  schedule: 40,
  observer: 20,
};

/**
 * Notices a turn going nowhere: `rounds` tool rounds in a row where every tool failed
 * (OpenMausBot's stall detection, adapted). The same identical failure is handled by the pipeline.
 */
export class StallDetector {
  /** Failed rounds in a row; any round with a success resets it. */
  private failedRounds = 0;

  constructor(
    /** How many failed rounds in a row stop the turn; three by default. */
    private readonly rounds = 3,
  ) {}

  /** Records one tool round; returns a reason when the turn should stop. */
  record(results: { isError: boolean }[]): string | undefined {
    if (!results.length) return undefined;
    this.failedRounds = results.every((r) => r.isError) ? this.failedRounds + 1 : 0;
    if (this.failedRounds >= this.rounds) {
      return `Stalled: ${this.failedRounds} tool rounds in a row failed without progress`;
    }
    return undefined;
  }
}
