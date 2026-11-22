import { BaseContextInjectable } from '../../ports/ContextInjectable.js';

/**
 * The computer-use section of the system prompt (S56). Structure first and pixels last, matching
 * the tool order; Take control is for credentials and CAPTCHAs, never for the agent to type secrets.
 */
export class ComputerUseInjectable extends BaseContextInjectable {
  readonly id = 'computer-use';
  readonly name = 'Computer use';
  readonly description =
    'How to drive the desktop: the tree first, screenshots last, and Take control for secrets';
  override placement = 'header' as const;
  override order = 1;

  render(): string {
    return [
      'Computer use:',
      '- Launch an allowed app with desktop.act({ action: "launch_app", app: "libreoffice" }); it works without a vision model.',
      '- Start with desktop.inspect and its [eN] refs, then desktop.act. Use computer.act only when the tree is missing or the app draws its own pixels; a screenshot costs far more than text.',
      '- If a sign-in, CAPTCHA or password blocks you, ask the owner to take control with computer.request_takeover. Never type a secret the owner did not give you for this action, and never ask them to type a secret while you hold the desktop.',
    ].join('\n');
  }
}
