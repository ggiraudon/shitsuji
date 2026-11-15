import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { MathEvaluateTool } from '../../src/adapters/tools/MathEvaluateTool.js';
import { Agent } from '../../src/application/Agent.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { ToolSearchTool } from '../../src/application/tools/ToolSearchTool.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { BaseTool, type ToolOutput } from '../../src/ports/Tool.js';
import { routerFor, ScriptedProvider, testServices, type ScriptedReply } from '../helpers.js';

const topics = [
  'invoice',
  'calendar',
  'weather',
  'translate',
  'photo',
  'music',
  'recipe',
  'flight',
];

/** A deferred tool that just echoes, named after a topic. */
class DeferredTool extends BaseTool<z.ZodObject<{ text: z.ZodString }>> {
  readonly input = z.object({ text: z.string() });
  readonly effect = 'read' as const;
  override readonly deferred = true;
  constructor(
    readonly name: string,
    readonly description: string,
  ) {
    super();
  }
  async run({ text }: { text: string }): Promise<ToolOutput> {
    return { content: `${this.name}: ${text}` };
  }
}

const setup = (replies: ScriptedReply[]) => {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const tools = new ToolCatalog([new MathEvaluateTool()]);
  for (let i = 0; i < 40; i++) {
    const topic = topics[i % topics.length]!;
    tools.add(new DeferredTool(`ext${i}.${topic}`, `Handle ${topic} requests, variant ${i}.`));
  }
  tools.add(new ToolSearchTool(() => tools.list()));
  const llm = new ScriptedProvider(replies);
  const agent = new Agent({
    name: 'Test',
    ownerId: asId<OwnerId>('owner'),
    models: routerFor(llm),
    tools,
    pipeline: new ToolPipeline(
      tools,
      defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
    ),
    repos,
    ...services,
  });
  return { agent, llm };
};

describe('deferred tool discovery (F05)', () => {
  it('sends only the core set and an index of the 40 deferred tools on the first request', async () => {
    const { agent, llm } = setup([{ content: 'Hello.' }]);
    await agent.send('Hi');
    const first = llm.requests[0]!;
    expect(first.tools!.map((t) => t.name).sort()).toEqual(['math.evaluate', 'tool_search']);
    expect(first.system).toContain('Find one with tool_search');
    expect(first.system).toContain('- ext0.invoice: Handle invoice requests, variant 0.');
    expect(first.system!.match(/^- ext\d+\./gm)).toHaveLength(40);
  });

  it('finds tools with tool_search, then sends their schemas so the model can call one', async () => {
    const { agent, llm } = setup([
      { toolCalls: [{ id: 's1', name: 'tool_search', arguments: { query: 'weather' } }] },
      { toolCalls: [{ id: 'c1', name: 'ext2.weather', arguments: { text: 'Paris' } }] },
      { content: 'Sunny in Paris.' },
    ]);
    const { reply } = await agent.send('Weather in Paris?');
    expect(reply).toBe('Sunny in Paris.');

    const searchResult = llm.requests[1]!.messages.at(-1)!.parts[0] as { content: string };
    expect(searchResult.content).toMatch(/^Matching tools/);
    expect(searchResult.content).toContain('ext2.weather');
    expect(searchResult.content).toContain('arguments: {');

    const names = llm.requests[1]!.tools!.map((t) => t.name);
    expect(names).toContain('ext2.weather');
    expect(names.length).toBeLessThanOrEqual(2 + 5);
    const toolResult = llm.requests[2]!.messages.at(-1)!.parts[0] as { content: string };
    expect(toolResult.content).toBe('ext2.weather: Paris');
  });

  it('says so when nothing matches', async () => {
    const search = new ToolSearchTool(() => []);
    expect((await search.run({ query: 'teleport' })).content).toBe('No tool matches "teleport".');
  });
});
