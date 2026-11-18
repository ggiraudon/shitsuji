import type { StandingRule } from './StandingRule.js';

/**
 * Rules every install has, whatever `trust.rules` says (X4). Sending the owner a file is an outside
 * action but it is the job, so it must not raise a card each time.
 *
 * Composition merges these with the owner's rules and the strongest wins (deny > ask > allow), so an
 * owner's `ask` or `deny` rule for `workspace.send` still overrides this one.
 */
export const SHIPPED_RULES: readonly StandingRule[] = [{ action: 'allow', tool: 'workspace.send' }];
