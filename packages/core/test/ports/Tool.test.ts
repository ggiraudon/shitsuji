import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { NullLogger } from '../../src/adapters/logging/loggers.js';
import { AnthropicProvider } from '../../src/adapters/models/AnthropicProvider.js';
import { OpenAICompatibleProvider } from '../../src/adapters/models/OpenAICompatibleProvider.js';
import { ToolNameMap } from '../../src/adapters/models/toolNames.js';
import { complete } from '../../src/application/modelCalls.js';
import { asId, type ToolCallId } from '../../src/domain/model/ids.js';
import { BaseTool, effectOf, toolSpec, type ToolContext } from '../../src/ports/Tool.js';
import { fixtureFetch } from '../fixtures/fixtureFetch.js';

class ExecTool extends BaseTool<typeof ExecTool.schema> {
  static schema = z.object({
    program: z.string().min(1).describe('The program to run'),
    args: z.array(z.string()).default([]),
    timeoutSeconds: z.number().int().positive().max(600).optional(),
  });
  readonly name = 'workspace.exec';
  readonly description = 'Run a program in the workspace';
  readonly input = ExecTool.schema;
  readonly effect = (a: z.infer<typeof ExecTool.schema>) =>
    a.program === 'ls' ? ('read' as const) : ('write_local' as const);
  async run(_args: z.infer<typeof ExecTool.schema>, _ctx: ToolContext) {
    return { content: '' };
  }
}

describe('tool specs', () => {
  it('turns the zod input into a JSON Schema the model can read', () => {
    expect(toolSpec(new ExecTool())).toEqual({
      name: 'workspace.exec',
      description: 'Run a program in the workspace',
      parameters: {
        type: 'object',
        properties: {
          program: { type: 'string', minLength: 1, description: 'The program to run' },
          args: { type: 'array', items: { type: 'string' }, default: [] },
          timeoutSeconds: { type: 'integer', exclusiveMinimum: 0, maximum: 600 },
        },
        required: ['program'],
      },
    });
  });

  it('has defaults for target, deferral and trust, and effects that depend on arguments', () => {
    const tool = new ExecTool();
    expect([tool.target, tool.deferred, tool.untrustedOutput]).toEqual(['core', false, false]);
    expect(effectOf(tool, { program: 'ls', args: [] })).toBe('read');
    expect(effectOf(tool, { program: 'rm', args: ['x'] })).toBe('write_local');
  });
});

describe('dotted tool names on the wire', () => {
  const spec = toolSpec(new ExecTool());
  const sse = (name: string) =>
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: '{"program":"ls"}' } }] } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

  it('maps dots to double underscores and back', () => {
    expect(ToolNameMap.toWire('workspace.exec')).toBe('workspace__exec');
    const names = new ToolNameMap([spec]);
    expect(names.internal('workspace__exec')).toBe('workspace.exec');
    expect(names.internal('unknown__tool')).toBe('unknown__tool');
  });

  it('OpenAI-compatible: sends workspace__exec and returns calls as workspace.exec', async () => {
    const fake = fixtureFetch({ body: sse('workspace__exec') });
    const p = new OpenAICompatibleProvider({
      id: 'd',
      baseUrl: 'http://x',
      log: new NullLogger(),
      fetch: fake.fetch,
    });
    const result = await complete(p, {
      model: 'm',
      tools: [spec],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'list' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              call: { id: asId<ToolCallId>('c0'), name: 'workspace.exec', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              toolCallId: asId<ToolCallId>('c0'),
              content: '',
              isError: false,
            },
          ],
        },
      ],
    });
    expect(result.toolCalls[0]!.name).toBe('workspace.exec');
    const body = fake.requests[0]!.body!;
    expect((body.tools as { function: { name: string } }[])[0]!.function.name).toBe(
      'workspace__exec',
    );
    const history = body.messages as { tool_calls?: { function: { name: string } }[] }[];
    expect(history[1]!.tool_calls![0]!.function.name).toBe('workspace__exec');
  });

  it('Anthropic: sends workspace__exec in tools and history', async () => {
    const fake = fixtureFetch({ fixture: 'anthropic-text.sse' });
    const p = new AnthropicProvider({
      id: 'a',
      apiKey: 'k',
      log: new NullLogger(),
      fetch: fake.fetch,
    });
    await complete(p, {
      model: 'm',
      tools: [spec],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'list' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              call: { id: asId<ToolCallId>('c0'), name: 'workspace.exec', arguments: {} },
            },
          ],
        },
      ],
    });
    const body = fake.requests[0]!.body!;
    expect((body.tools as { name: string }[])[0]!.name).toBe('workspace__exec');
    const history = body.messages as { content: { name?: string }[] }[];
    expect(history[1]!.content[0]!.name).toBe('workspace__exec');
  });
});
