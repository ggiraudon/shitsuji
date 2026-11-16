import type { ToolTarget } from '../../ports/Tool.js';

/** What a standing rule says to do with the actions it matches (F11, S34). */
export type RuleAction = 'allow' | 'ask' | 'deny';

/**
 * A rule from the owner's words ("always ask before emailing clients"), kept until F16 stores them.
 * It matches a tool name or glob, and optionally one target.
 */
export interface StandingRule {
  /** The owner's words, for the receipt and the approval card. */
  detail?: string;
  action: RuleAction;
  /** Tool name or glob: `*` is any run of characters, `?` exactly one. Case-sensitive. */
  tool: string;
  /** Only this target, when set; any target otherwise. */
  target?: ToolTarget;
}

export interface RuleSubject {
  tool: string;
  target: ToolTarget;
}

/** True when the rule names this action. */
export function ruleMatches(rule: StandingRule, subject: RuleSubject): boolean {
  if (rule.target && rule.target !== subject.target) return false;
  return globToRegExp(rule.tool).test(subject.tool);
}

/** The rule that decides, if any: "never" beats "always ask", which beats "go ahead". */
export function strongestRule(
  rules: readonly StandingRule[],
  subject: RuleSubject,
): StandingRule | undefined {
  const matches = rules.filter((rule) => ruleMatches(rule, subject));
  return (
    matches.find((rule) => rule.action === 'deny') ??
    matches.find((rule) => rule.action === 'ask') ??
    matches[0]
  );
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${body}$`);
}
