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
      '- Prefer a shortcut, a known name or one sequence: desktop.inspect({ app: "soffice", find: { name } }) searches every window of that app, dialogs included, and desktop.wait waits for a window or element after a launch or Save (a timeout is normal). One desktop.act takes up to 20 { type } / { key } steps and reports the focus and any new or closed window, not the whole tree.',
      '- Start with desktop.inspect and its [eN] refs, then desktop.act. Use computer.act only when the tree is missing or the app draws its own pixels; a screenshot costs far more than text. A node marked (offscreen) is not visible: use its ref or scroll, do not click its pixel.',
      '- A new dialog belongs to the app, not the window that opened it, and its accessible name can differ from its title: inspect the app (soffice for LibreOffice) or use the window the action reported.',
      '- In a save dialog type a plain file name (calc.csv) or a full path (/workspace/calc.csv); the dialog already points at the workspace, so do not repeat the workspace/ prefix.',
      '- desktop.windows lists the windows; desktop.window moves, resizes or focuses one that is off screen. Errors have a second Remedy line; "sent, unconfirmed" means the action may not have landed, so inspect before trying again. Accented text is pasted through the clipboard, which is restored.',
      '- If a sign-in, CAPTCHA or password blocks you, ask the owner to take control with computer.request_takeover. Never type a secret the owner did not give you for this action, and never ask them to type a secret while you hold the desktop.',
    ].join('\n');
  }
}
