import { z } from 'zod/v4';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

export interface TestMailToolOptions {
  /** Where the mock mailbox listens (the evaluation harness). */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const input = z.object({
  to: z.string().min(1).max(320).describe('The recipient address'),
  subject: z.string().min(1).max(200).describe('The subject line'),
  body: z.string().min(1).max(4_000).describe('The message body'),
});

/**
 * `test.mail` posts a message to a local mock mailbox (F11, S38). Its effect is `external`, so the
 * whole trust path applies; the evaluation harness uses it to check that no email ever leaves without
 * the owner's words or an approval.
 */
export class TestMailTool extends BaseTool<typeof input> {
  readonly name = 'test.mail';
  readonly description =
    'Send an email through the local test mailbox. It acts outside the workspace, so trust checks it ' +
    'and may ask the owner first.';
  readonly input = input;
  readonly effect = 'external' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: TestMailToolOptions) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async run({ to, subject, body }: z.infer<typeof input>, _ctx: ToolContext): Promise<ToolOutput> {
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, subject, body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return { content: `The test mailbox answered ${response.status}.`, isError: true };
      }
      return { content: 'Email sent.', data: { status: response.status } };
    } catch (error) {
      return {
        content: `Could not reach the test mailbox: ${(error as Error)?.message ?? String(error)}`,
        isError: true,
      };
    }
  }
}
