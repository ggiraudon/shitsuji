import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares the presented token with the configured one without leaking its length or prefix: both
 * are hashed to a fixed size first, then compared in constant time.
 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(a, b);
}
