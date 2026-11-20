import fs from 'node:fs';
import { z } from 'zod';

/**
 * The file core writes from `sandbox.egress.allow/deny` (F08, S48), so the owner edits one config
 * file instead of the proxy's environment in `.env`. Unknown keys are refused: a typo must not
 * quietly widen the policy.
 */
export const egressRulesFileSchema = z
  .object({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
    /**
     * Core writes `true` when it has written its lists (S48). Compose seeds `false` on a fresh
     * volume, so the proxy denies everything until core's config arrives instead of starting open.
     */
    ready: z.boolean().default(true),
  })
  .strict();
export type EgressRulesFileBody = z.infer<typeof egressRulesFileSchema>;

/** The rules file's lists, or `undefined` when there is no file yet (the env lists still apply). */
export function readRulesFile(file: string): EgressRulesFileBody | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return egressRulesFileSchema.parse(JSON.parse(raw));
}

/** Both sources are authoritative, so a rule in either applies; duplicates are dropped in order. */
export function mergeRules(
  fromEnv: { allow: readonly string[]; deny: readonly string[] },
  fromFile: Pick<EgressRulesFileBody, 'allow' | 'deny'> | undefined,
): { allow: string[]; deny: string[] } {
  const union = (a: readonly string[], b: readonly string[] = []) => [...new Set([...a, ...b])];
  return {
    allow: union(fromEnv.allow, fromFile?.allow),
    deny: union(fromEnv.deny, fromFile?.deny),
  };
}
