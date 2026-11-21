import { z } from 'zod/v4';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

/** What `test.mail` posts to: the local mock mailbox, with test seams for fetch and timeout. */
export interface TestMailToolOptions {
  /** Where the mock mailbox listens (the evaluation harness). */
  url: string;
  /** The fetch implementation, injectable for tests. */
  fetch?: typeof fetch;
  /** The POST's timeout; five seconds by default. */
  timeoutMs?: number;
}

const input = z.object({
  /** The recipient address as the model wrote it; the mock mailbox does not validate it. */
  to: z.string().min(1).max(320).describe('The recipient address'),
  /** The subject line. */
  subject: z.string().min(1).max(200).describe('The subject line'),
  /** The message body, up to 4k characters. */
  body: z.string().min(1).max(4_000).describe('The message body'),
});

/**
 * `test.mail` posts a message to a local mock mailbox (F11, S38). Its effect is `external`, so the
 * whole trust path applies; the evaluation harness uses it to check that no email ever leaves without
 * the owner's words or an approval.
 */
export class TestMailTool extends BaseTool<typeof input> {
  /** The tool's name, `test.mail`. */
  readonly name = 'test.mail';
  /** What the model reads: an outside action, so trust may ask first. */
  readonly description =
    'Send an email through the local test mailbox. It acts outside the workspace, so trust checks it ' +
    'and may ask the owner first.';
  /** The message schema. */
  readonly input = input;
  /** Acting outside the workspace, so the trust policy decides. */
  readonly effect = 'external' as const;
  /** The fetch implementation, shared by every post. */
  private readonly fetchImpl: typeof fetch;
  /** The POST's timeout in milliseconds. */
  private readonly timeoutMs: number;

  constructor(
    /** The mailbox URL and the test seams. */
    private readonly options: TestMailToolOptions,
  ) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  /** Posts the message; any failure is an ordinary tool error, not a throw. */
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
