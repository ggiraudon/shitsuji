/** One AbortController per running turn. Stop aborts it; the runner then marks the turn cancelled. */
export class StopController {
  /** The controllers for the turns this process is running, by turn id. */
  private readonly running = new Map<string, AbortController>();

  /** The signal for a turn that is starting. */
  begin(turnId: string): AbortSignal {
    const controller = new AbortController();
    this.running.set(turnId, controller);
    return controller.signal;
  }

  /** Forgets a turn once it ended; the runner calls it in a `finally`. */
  end(turnId: string): void {
    this.running.delete(turnId);
  }

  /** Aborts a running turn. Returns false if this process is not running it. */
  stop(turnId: string, reason = 'stopped by owner'): boolean {
    const controller = this.running.get(turnId);
    if (!controller) return false;
    controller.abort(new TurnStopped(reason));
    return true;
  }

  /** Whether this process is running the turn (another process may be, and this cannot see it). */
  isRunning(turnId: string): boolean {
    return this.running.has(turnId);
  }
}

/** The abort reason a Stop puts on the signal, so the runner can tell it from a timeout. */
export class TurnStopped extends Error {
  /** The class name, for logs; the message is the owner-readable reason. */
  override readonly name = 'TurnStopped';
}
