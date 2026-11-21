import { z } from 'zod/v4';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

/** What `test.notify` posts to: the local mock service, with test seams for time and fetch. */
export interface NotifyToolOptions {
  /** Where the local mock service listens (S38's evaluation harness). */
  url: string;
  /** The fetch implementation, injectable for tests. */
  fetch?: typeof fetch;
  /** The POST's timeout; five seconds by default. */
  timeoutMs?: number;
  /** The clock for the posted timestamp, injectable for deterministic tests. */
  now?: () => Date;
}

const input = z.object({
  /** The notification text to post. */
  text: z.string().min(1).max(1_000).describe('The notification to post'),
});

/**
 * `test.notify` posts to a local mock service, so the whole trust path (judge, approval card, run)
 * can be exercised without a real outside integration (F11, S36). Its effect is `external`, which is
 * the point: it can never run on its own.
 */
export class NotifyTool extends BaseTool<typeof input> {
  /** The tool's name, `test.notify`. */
  readonly name = 'test.notify';
  /** What the model reads: an outside action, so trust may ask first. */
  readonly description =
    'Post a notification to the local test service. It acts outside the workspace, so trust checks it ' +
    'and may ask the owner first.';
  /** The notification schema. */
  readonly input = input;
  /** Acting outside the workspace, so the trust policy decides. */
  readonly effect = 'external' as const;
  /** The fetch implementation, shared by every post. */
  private readonly fetchImpl: typeof fetch;
  /** The POST's timeout in milliseconds. */
  private readonly timeoutMs: number;
  /** The clock for the posted timestamp. */
  private readonly now: () => Date;

  constructor(
    /** The service URL and the test seams. */
    private readonly options: NotifyToolOptions,
  ) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Posts the text with a timestamp; any failure is an ordinary tool error, not a throw. */
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
