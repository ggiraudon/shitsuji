import type { Clock } from '../../ports/Clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock that only moves when told to. For tests and replays. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(time: Date | string): void {
    this.current = new Date(time);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
