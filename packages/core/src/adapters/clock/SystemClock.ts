import type { Clock } from '../../ports/Clock.js';

/** The real clock: `new Date()` per call. Production uses this; tests use `ManualClock`. */
export class SystemClock implements Clock {
  /** The current instant, from the host's clock. */
  now(): Date {
    return new Date();
  }
}

/** A clock that only moves when told to. For tests and replays. */
export class ManualClock implements Clock {
  /** The instant returned by `now` until `set` or `advance` changes it. */
  private current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start);
  }

  /** A copy of the current instant, so a caller cannot mutate the clock. */
  now(): Date {
    return new Date(this.current);
  }

  /** Moves the clock to a fixed instant, forwards or backwards. */
  set(time: Date | string): void {
    this.current = new Date(time);
  }

  /** Moves the clock forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
