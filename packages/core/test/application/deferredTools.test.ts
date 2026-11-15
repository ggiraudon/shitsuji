import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { MathEvaluateTool } from '../../src/adapters/tools/MathEvaluateTool.js';
import { Agent } from '../../src/application/Agent.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import { ToolCallGateway } from '../../src/application/tools/ToolCallGateway.js';
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

const setup = async (replies: ScriptedReply[]) => {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const tools = new ToolCatalog([new MathEvaluateTool()]);
  for (let i = 0; i < 40; i++) {
    const topic = topics[i % topics.length]!;
    tools.add(new DeferredTool(`ext${i}.${topic}`, `Handle ${topic} requests, variant ${i}.`));
  }
  tools.add(new ToolSearchTool(() => tools.list()));
  tools.add(new ToolCallGateway());
  const llm = new ScriptedProvider(replies);
  const jobs = new InMemoryJobQueue(services.log, services.clock);
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
    jobs,
    ...services,
  });
  await jobs.start();
  await agent.start();
  return { agent, llm };
};

describe('deferred tool discovery (F05)', () => {
  it('sends only the core set and an index of the 40 deferred tools on the first request', async () => {
    const { agent, llm } = await setup([{ content: 'Hello.' }]);
    await agent.send('Hi');
    const first = llm.requests[0]!;
    expect(first.tools!.map((t) => t.name).sort()).toEqual([
      'math.evaluate',
      'tool_call',
      'tool_search',
    ]);
    expect(first.system).toContain('Find one with tool_search, then call it with tool_call');
    expect(first.system).toContain('- ext0.invoice: Handle invoice requests, variant 0.');
    expect(first.system!.match(/^- ext\d+\./gm)).toHaveLength(40);
  });

  it('finds a tool with tool_search and calls it through tool_call, with the tool list unchanged', async () => {
    const { agent, llm } = await setup([
      { toolCalls: [{ id: 's1', name: 'tool_search', arguments: { query: 'weather' } }] },
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'tool_call',
            arguments: { name: 'ext2.weather', arguments: { text: 'Paris' } },
          },
        ],
      },
      { content: 'Sunny in Paris.' },
    ]);
    const { reply } = await agent.send('Weather in Paris?');
    expect(reply).toBe('Sunny in Paris.');

    // The schema arrives in the search result (appended to the history), not in the tool list.
    const searchResult = llm.requests[1]!.messages.at(-1)!.parts[0] as { content: string };
    expect(searchResult.content).toMatch(/^Matching tools\. Call one with tool_call/);
    expect(searchResult.content).toContain('ext2.weather');
    expect(searchResult.content).toContain('arguments: {');
    const toolResult = llm.requests[2]!.messages.at(-1)!.parts[0] as { content: string };
    expect(toolResult.content).toBe('ext2.weather: Paris');

    // The tool list is identical on every request of the session, so the prompt cache stays valid.
    const lists = llm.requests.map((r) => JSON.stringify(r.tools));
    expect(new Set(lists).size).toBe(1);
    expect(llm.requests[0]!.tools!.map((t) => t.name).sort()).toEqual([
      'math.evaluate',
      'tool_call',
      'tool_search',
    ]);
  });

  it('validates tool_call against the real tool and reports unknown tools', async () => {
    const { agent, llm } = await setup([
      {
        toolCalls: [
          {
            id: 'a',
            name: 'tool_call',
            arguments: { name: 'ext2.weather', arguments: { text: 42 } },
          },
        ],
      },
      { toolCalls: [{ id: 'b', name: 'tool_call', arguments: { name: 'nope.tool' } }] },
      { content: 'ok' },
      { toolCalls: [{ id: 'c', name: 'tool_call', arguments: { arguments: {} } }] },
      { content: 'ok' },
    ]);
    await agent.send('try');
    await agent.send('again');
    const lastResult = (i: number) =>
      (llm.requests[i]!.messages.at(-1)!.parts[0] as { content: string }).content;
    expect(lastResult(1)).toMatch(
      /^Error \(invalid_input\): Invalid arguments for ext2\.weather: text:/,
    );
    expect(lastResult(2)).toMatch(/^Error \(not_found\): There is no tool named "nope\.tool"/);
    expect(lastResult(4)).toMatch(
      /^Error \(invalid_input\): Invalid arguments for tool_call: name:/,
    );
  });

  it('says so when nothing matches', async () => {
    const search = new ToolSearchTool(() => []);
    expect((await search.run({ query: 'teleport' })).content).toBe('No tool matches "teleport".');
  });
});
