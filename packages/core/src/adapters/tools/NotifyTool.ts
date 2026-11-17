import { z } from 'zod/v4';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

export interface NotifyToolOptions {
  /** Where the local mock service listens (S38's evaluation harness). */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

const input = z.object({
  text: z.string().min(1).max(1_000).describe('The notification to post'),
});

/**
 * `test.notify` posts to a local mock service, so the whole trust path (judge, approval card, run)
 * can be exercised without a real outside integration (F11, S36). Its effect is `external`, which is
 * the point: it can never run on its own.
 */
export class NotifyTool extends BaseTool<typeof input> {
  readonly name = 'test.notify';
  readonly description =
    'Post a notification to the local test service. It acts outside the workspace, so trust checks it ' +
    'and may ask the owner first.';
  readonly input = input;
  readonly effect = 'external' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: NotifyToolOptions) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  async run({ text }: z.infer<typeof input>, _ctx: ToolContext): Promise<ToolOutput> {
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, at: this.now().toISOString() }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return { content: `The test service answered ${response.status}.`, isError: true };
      }
      return { content: 'Notification sent.', data: { status: response.status } };
    } catch (error) {
      return {
        content: `Could not reach the test service: ${(error as Error)?.message ?? String(error)}`,
        isError: true,
      };
    }
  }
}
