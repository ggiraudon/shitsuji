/** One AbortController per running turn. Stop aborts it; the runner then marks the turn cancelled. */
export class StopController {
  private readonly running = new Map<string, AbortController>();

  /** The signal for a turn that is starting. */
  begin(turnId: string): AbortSignal {
    const controller = new AbortController();
    this.running.set(turnId, controller);
    return controller.signal;
  }

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

  isRunning(turnId: string): boolean {
    return this.running.has(turnId);
  }
}

export class TurnStopped extends Error {
  override readonly name = 'TurnStopped';
}
