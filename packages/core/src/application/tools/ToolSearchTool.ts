import { z } from 'zod/v4';
import { BaseTool, toolSpec, type Tool, type ToolOutput } from '../../ports/Tool.js';

const input = z.object({
  query: z.string().min(1).describe('What the tool should do, e.g. "send email" or "read pdf"'),
});

/**
 * tool_search: finds tools by name and description. The top 3 strong matches come back with their
 * full schemas, so the model can call one on the next step without another lookup (F05).
 */
export class ToolSearchTool extends BaseTool<typeof input> {
  readonly name = 'tool_search';
  readonly description =
    'Find a tool that is not listed in this request. Returns up to 5 matches; call one with tool_call.';
  readonly input = input;
  readonly effect = 'read' as const;

  constructor(private readonly tools: () => readonly Tool[]) {
    super();
  }

  async run({ query }: z.infer<typeof input>): Promise<ToolOutput> {
    const words = tokens(query);
    const scored = this.tools()
      .filter((t) => t.name !== this.name)
      .map((tool) => ({ tool, score: score(tool, words) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, 5);
    if (!scored.length) return { content: `No tool matches "${query}".`, data: { names: [] } };
    const best = scored[0]!.score;
    const strong = scored.filter((s, i) => i < 3 && s.score >= best * 0.6).map((s) => s.tool.name);
    const lines = scored.map(({ tool }) =>
      strong.includes(tool.name)
        ? `- ${tool.name}: ${tool.description}\n  arguments: ${JSON.stringify(toolSpec(tool).parameters)}`
        : `- ${tool.name}: ${tool.description}`,
    );
    return {
      content:
        `Matching tools. Call one with tool_call, e.g. ` +
        `{"name": "${scored[0]!.tool.name}", "arguments": {…}}:\n${lines.join('\n')}`,
      data: { names: scored.map((s) => s.tool.name) },
    };
  }
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

function score(tool: Tool, words: string[]): number {
  const name = tokens(tool.name);
  const desc = new Set(tokens(tool.description));
  let total = 0;
  for (const w of words) {
    if (name.includes(w)) total += 3;
    else if (name.some((n) => n.startsWith(w) || w.startsWith(n))) total += 2;
    if (desc.has(w)) total += 1;
  }
  return total;
}
