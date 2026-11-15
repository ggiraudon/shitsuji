import { ManualClock } from '../src/adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../src/adapters/events/InProcessEventBus.js';
import { MemoryLogger } from '../src/adapters/logging/loggers.js';
import type { CoreServices } from '../src/composition/services.js';
import { BaseChannel } from '../src/ports/Channel.js';
import type { LLMCompletionOptions, LLMProvider, LLMResponse } from '../src/ports/LLMProvider.js';

export function testServices(): CoreServices & { log: MemoryLogger; clock: ManualClock } {
  const log = new MemoryLogger();
  const clock = new ManualClock();
  return { log, clock, events: new InProcessEventBus(log, clock) };
}

/** A model that replies with the scripted responses in order. */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly requests: LLMCompletionOptions[] = [];
  constructor(private readonly replies: Partial<LLMResponse>[] = []) {}
  async complete(options: LLMCompletionOptions): Promise<LLMResponse> {
    this.requests.push(structuredClone(options));
    const reply = this.replies.shift();
    if (!reply) throw new Error('No scripted reply left');
    return { id: 'r', model: options.model ?? 'm', content: '', finishReason: 'stop', ...reply };
  }
  getModels() {
    return ['m'];
  }
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

export const until = async (check: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};
