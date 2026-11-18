import { ManualClock } from '../src/adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../src/adapters/events/InProcessEventBus.js';
import { MemoryLogger } from '../src/adapters/logging/loggers.js';
import { ModelCatalog } from '../src/application/models/ModelCatalog.js';
import { ModelRouter } from '../src/application/models/ModelRouter.js';
import { PlainTextRenderer } from '../src/adapters/channels/PlainTextRenderer.js';
import { TAIL_MARKER } from '../src/application/context/ContextBuilder.js';
import type { CoreServices } from '../src/composition/services.js';
import {
  BaseChannelAdapter,
  type ChannelCapabilities,
  type ChannelTarget,
  type InboundSink,
  type OutboundMessage,
} from '../src/ports/ChannelAdapter.js';
import type { ToolCallId } from '../src/domain/model/ids.js';
import type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../src/ports/ModelProvider.js';

export function testServices(): CoreServices & { log: MemoryLogger; clock: ManualClock } {
  const log = new MemoryLogger();
  const clock = new ManualClock();
  return { log, clock, events: new InProcessEventBus(log, clock) };
}

export interface ScriptedReply {
  content?: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** Defaults to `tool_calls` when calls are scripted, `stop` otherwise; `length` simulates a cutoff. */
  finishReason?: FinishReason;
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
    yield {
      type: 'done',
      finishReason: reply.finishReason ?? (reply.toolCalls?.length ? 'tool_calls' : 'stop'),
    };
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

/** The tail injectables ride on the newest message (S23); the transcript itself is unchanged. */
/** A tail note is Shitsuji's own context, not part of the stored transcript (#66). */
const isTailNote = (text: string) =>
  text.startsWith(TAIL_MARKER) || text.startsWith('Current local date and time for your owner:');

/** A request's messages as "role:text" lines (tool results show their content). */
export function transcript(request: ModelRequest): string[] {
  return (
    request.messages
      .map((m) => ({
        role: m.role,
        parts: m.parts.filter((p) => !(p.type === 'text' && isTailNote(p.text))),
      }))
      // A message that carried nothing but the tail is not part of the stored transcript.
      .filter((m) => m.parts.length > 0)
      .map(
        (m) =>
          `${m.role}:` +
          m.parts
            .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : ''))
            .join(''),
      )
  );
}

/** A channel driven by the test: `receive()` simulates an incoming message. */
export class TestChannel extends BaseChannelAdapter {
  readonly id = 'test';
  override readonly requiresPairing: boolean;
  readonly capabilities: ChannelCapabilities = {
    markdown: 'basic',
    buttons: false,
    files: false,
    images: false,
    voice: false,
    edits: false,
    maxMessageLength: 100_000,
  };
  readonly sent: { destination: string; message: string }[] = [];
  /** The raw outbound messages, for tests that care about file parts (S33). */
  readonly delivered: OutboundMessage[] = [];
  readonly typingCalls: string[] = [];
  started = 0;
  stopped = 0;
  private readonly renderer = new PlainTextRenderer();

  constructor(requiresPairing = false) {
    super();
    this.requiresPairing = requiresPairing;
  }

  override async start(sink: InboundSink) {
    this.started++;
    await super.start(sink);
  }

  override async stop() {
    this.stopped++;
    await super.stop();
  }

  async deliver(target: ChannelTarget, message: OutboundMessage) {
    this.delivered.push(message);
    this.sent.push({
      destination: target.chatId,
      message: this.renderer.render(message, this.capabilities).text,
    });
    return { delivered: true };
  }

  async typing(target: ChannelTarget) {
    this.typingCalls.push(target.chatId);
  }

  receive(content: string, destination = 'someone') {
    void this.sink?.receive({
      channel: this.id,
      chatId: destination,
      text: content,
      receivedAt: new Date(),
    });
  }

  /** Asks the sink as an adapter does before storing a file (F06, #44). */
  accepted(chatId: string): Promise<boolean | undefined> {
    return this.sink?.accepts?.({ channel: this.id, chatId }) ?? Promise.resolve(undefined);
  }
}

export const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 1000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};
