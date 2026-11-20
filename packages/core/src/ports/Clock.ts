/**
 * The source of the current time. Inject it instead of calling `new Date()`, so tests control time.
 * Every timestamp the runtime writes and every event's `at` comes from here, so a turn's start, end and
 * `startAfter` all agree with each other and with a manual clock in a test.
 */
export interface Clock {
  /** The current instant. Call it per use; nothing here caches the time. */
  now(): Date;
}
