/** The source of the current time. Inject it instead of calling `new Date()`, so tests control time. */
export interface Clock {
  now(): Date;
}
