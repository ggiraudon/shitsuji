import { ManualClock } from '../src/adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../src/adapters/events/InProcessEventBus.js';
import { MemoryLogger } from '../src/adapters/logging/loggers.js';
import { ModelCatalog } from '../src/application/models/ModelCatalog.js';
import { ModelRouter } from '../src/application/models/ModelRouter.js';
import type { CoreServices } from '../src/composition/services.js';
import { BaseChannel } from '../src/ports/Channel.js';
import type { ToolCallId } from '../src/domain/model/ids.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from '../src/ports/ModelProvider.js';

export function testServices(): CoreServices & { log: MemoryLogger; clock: ManualClock } {
  const log = new MemoryLogger();
  const clock = new ManualClock();
  return { log, clock, events: new InProcessEventBus(log, clock) };
}

export interface ScriptedReply {
  content?: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** A model that replies with the scripted responses in order, recording every request. */
export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly replies: ScriptedReply[] = [],
    readonly id = 'scripted',
  ) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    const reply = this.replies.shift();
    if (!reply) throw new Error('No scripted reply left');
    if (reply.reasoning) yield { type: 'reasoning_delta', text: reply.reasoning };
    if (reply.content) yield { type: 'text_delta', text: reply.content };
    for (const c of reply.toolCalls ?? []) {
      yield { type: 'tool_call', call: { ...c, id: c.id as ToolCallId } };
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'done', finishReason: reply.toolCalls?.length ? 'tool_calls' : 'stop' };
  }
  async listModels() {
    return ['m'];
  }
}

/** A router whose chat purpose is `provider/model`, for tests that need an Agent. */
export function routerFor(provider: ModelProvider, model = 'test-model'): ModelRouter {
  return new ModelRouter(
    new Map([[provider.id, provider]]),
    { purposes: { chat: `${provider.id}/${model}` }, fallbacks: {} },
    new ModelCatalog(),
    new MemoryLogger(),
  );
}

/** A request's messages as "role:text" lines (tool results show their content). */
export function transcript(request: ModelRequest): string[] {
  return request.messages.map(
    (m) =>
      `${m.role}:` +
      m.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : ''))
        .join(''),
  );
}

/** A channel driven by the test: `receive()` simulates an incoming message. */
export class TestChannel extends BaseChannel {
  readonly sent: { destination: string; message: string }[] = [];
  started = 0;
  stopped = 0;
  constructor(readonly name = 'test') {
    super();
  }
  override async start() {
    this.started++;
    await super.start();
  }
  override async stop() {
    this.stopped++;
    await super.stop();
  }
  async send(destination: string, message: string) {
    this.sent.push({ destination, message });
  }
  receive(content: string, destination = 'someone') {
    this.emitMessage({ id: 'm', role: 'user', content, timestamp: 0 }, destination);
  }
}

export const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 1000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};
