import { BaseContextInjectable } from '../../ports/ContextInjectable.js';

/**
 * The computer-use section of the system prompt (S56). Structure first and pixels last, matching
 * the tool order; Take control is for credentials and CAPTCHAs, never for the agent to type secrets.
 * The S56 live run added the practical rules: a shortcut, a known name or one input batch before
 * another tree read, a dialog found through its application, a plain save name, and the
 * `(offscreen)` mark.
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
      '- Prefer a shortcut, a known name or one sequence over clicking around: find a cell or button with desktop.inspect({ window, find: { name } }), and give one desktop.act up to 20 { type } / { key } steps. Inspect again when you are unsure what is on screen, or when a ref went stale.',
      '- Start with desktop.inspect and its [eN] refs, then desktop.act. Use computer.act only when the tree is missing or the app draws its own pixels; a screenshot costs far more than text. A node marked (offscreen) is not visible: use its ref or scroll, do not click its pixel.',
      '- A new dialog usually belongs to the app, not the window that opened it. Inspect the app (window "soffice" for LibreOffice) to reach the active dialog, whose accessible name can differ from its title bar.',
      '- In a save dialog type a plain file name (calc.csv) or a full path (/workspace/calc.csv); the dialog already points at the workspace, so do not repeat the workspace/ prefix.',
      '- When an app asks to overwrite a file, answer its prompt (Overwrite, or a new name); do not move or rename the existing file to get around it.',
      '- If a sign-in, CAPTCHA or password blocks you, ask the owner to take control with computer.request_takeover. Never type a secret the owner did not give you for this action, and never ask them to type a secret while you hold the desktop.',
    ].join('\n');
  }
}
