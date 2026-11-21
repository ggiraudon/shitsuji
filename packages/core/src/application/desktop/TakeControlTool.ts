import { z } from 'zod/v4';
import { asId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import type { TakeControlPort } from '../../ports/DesktopControl.js';
import {
  BaseTool,
  type Tool,
  type ToolContext,
  type ToolEffect,
  type ToolOutput,
} from '../../ports/Tool.js';

const schema = z
  .object({
    /** Why the agent needs the desktop; shown to the owner as the agent's own words. */
    reason: z.string().min(1).max(1_000),
  })
  .strict();

type Args = z.infer<typeof schema>;

/**
 * `computer.request_takeover` (S55): asks the owner for the desktop. The control service enters
 * owner mode and returns the question; the runner pauses this turn with it, so the owner's channel
 * gets the reason and the viewer link. The turn resumes on Give back, expiry or a restart.
 */
export class RequestTakeoverTool extends BaseTool<typeof schema> {
  readonly name = 'computer.request_takeover';
  readonly description =
    'Ask the owner to take control of the desktop when you are stuck (a CAPTCHA, a sign-in or an ' +
    'ambiguous screen). The turn pauses until they give the desktop back.';
  readonly input = schema;
  override readonly target = 'desktop' as const;
  readonly effect: ToolEffect = 'write_local';

  constructor(private readonly control: TakeControlPort) {
    super();
  }

  async run(args: Args, ctx: ToolContext): Promise<ToolOutput> {
    const answer = await this.control.requestByAgent({
      sessionId: asId<SessionId>(ctx.sessionId),
      turnId: asId<TurnId>(ctx.turnId),
      reason: args.reason,
    });
    if (!answer.ok || !answer.question) {
      return { content: answer.message, isError: true };
    }
    if (!ctx.requestPause) {
      // Without a runner that can pause, owner mode would strand the desktop; give it straight back.
      this.control.abandonAgentRequest();
      return {
        content:
          'Take control needs a running turn that can pause, and this run cannot; the desktop ' +
          'stays with the agent.',
        isError: true,
      };
    }
    ctx.requestPause(answer.question);
    return {
      content: answer.message,
      data: { action: 'request_takeover', reason: args.reason, mode: 'owner' },
    };
  }
}

/** The takeover request tool; registered only when the sandbox has a desktop and a control service. */
export function takeControlTools(control: TakeControlPort): Tool[] {
  return [new RequestTakeoverTool(control)];
}
