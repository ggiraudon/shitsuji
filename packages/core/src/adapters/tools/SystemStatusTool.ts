import { z } from 'zod/v4';
import { BaseTool, type ToolOutput } from '../../ports/Tool.js';

const input = z.object({});

/** system.status: Shitsuji's own health (not the host's). The composition root supplies the facts. */
export class SystemStatusTool extends BaseTool<typeof input> {
  readonly name = 'system.status';
  readonly description =
    "Report Shitsuji's own status: version, uptime, storage, chat model and enabled tools.";
  readonly input = input;
  readonly effect = 'read' as const;

  constructor(
    /** The facts the composition root can report; called per request so they are current. */
    private readonly status: () => Promise<Record<string, unknown>>,
  ) {
    super();
  }

  /** The facts as pretty JSON, also returned as `data` for a receipt. */
  async run(): Promise<ToolOutput> {
    const facts = await this.status();
    return { content: JSON.stringify(facts, null, 2), data: facts };
  }
}
