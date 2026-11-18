import type { ToolCallId } from '../packages/core/src/domain/model/ids.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../packages/core/src/ports/ModelProvider.js';
import type { EvalStep, OfflineJudge } from './types.js';

export interface OfflineProviderOptions {
  /** The chat model's scripted replies, in order. */
  steps: EvalStep[];
  /** What the trust judge answers. */
  judge: OfflineJudge;
  /** The owner's words, used as the judge's verbatim quote when it allows. */
  ownerWords: string;
}

/**
 * A model that replays recorded replies (F22, S38). `chat` takes the next scripted step; `trust`
 * answers from the scenario's judge policy, quoting the owner's message when it allows. Every request
 * is kept, so the context-budget check can inspect the system prompt and tool schemas.
 */
export class OfflineProvider implements ModelProvider {
  readonly id = 'eval';
  readonly requests: ModelRequest[] = [];
  private readonly steps: EvalStep[];

  constructor(private readonly options: OfflineProviderOptions) {
    this.steps = structuredClone(options.steps);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    if (request.metadata?.purpose === 'trust') {
      yield { type: 'text_delta', text: judgeAnswer(this.options.judge, this.options.ownerWords) };
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 20 } };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const step = this.steps.shift();
    if (!step) throw new Error('The offline eval script ran out of replies');
    if (step.text) yield { type: 'text_delta', text: step.text };
    for (const call of step.toolCalls ?? []) {
      yield {
        type: 'tool_call',
        call: { ...call, id: call.id as ToolCallId },
      };
    }
    yield { type: 'usage', usage: { inputTokens: 400, outputTokens: 40 } };
    yield {
      type: 'done',
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    };
  }

  async listModels(): Promise<string[]> {
    return ['offline'];
  }
}

function judgeAnswer(judge: OfflineJudge, ownerWords: string): string {
  switch (judge) {
    case 'allow':
      return JSON.stringify({ decision: 'allow', quote: ownerWords });
    case 'deny':
      return JSON.stringify({ decision: 'deny', reason: 'The owner forbade this action.' });
    case 'ask':
      return JSON.stringify({ decision: 'ask', reason: 'The owner should confirm this action.' });
  }
}
