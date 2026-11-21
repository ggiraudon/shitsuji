import type { ToolCall } from '../domain/model/Message.js';
import type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  TokenUsage,
} from '../ports/ModelProvider.js';

/** A whole streamed response collected into one value: the text, the reasoning, the calls and cost. */
export interface ModelResponse {
  /** The reply text, deltas joined. */
  text: string;
  /** Model reasoning, kept apart so it is never shown as the reply or sent back (F03). */
  reasoning: string;
  /** Tool calls in the order the model emitted them. */
  toolCalls: ToolCall[];
  /** What the request cost, when the provider reported it. */
  usage?: TokenUsage;
  /** Why the stream ended; `tool_calls` means the loop must run the calls and continue. */
  finishReason: FinishReason;
}

/** Collects a whole response from a provider's stream. */
export async function complete(
  provider: ModelProvider,
  request: ModelRequest,
  signal?: AbortSignal,
  /** Called with every stream event as it arrives (e.g. to stream text to a UI). */
  onEvent?: (event: ModelStreamEvent) => void,
): Promise<ModelResponse> {
  const out: ModelResponse = { text: '', reasoning: '', toolCalls: [], finishReason: 'other' };
  for await (const event of provider.stream(request, signal)) {
    onEvent?.(event);
    switch (event.type) {
      case 'text_delta':
        out.text += event.text;
        break;
      case 'reasoning_delta':
        out.reasoning += event.text;
        break;
      case 'tool_call':
        out.toolCalls.push(event.call);
        break;
      case 'usage':
        out.usage = event.usage;
        break;
      case 'done':
        out.finishReason = event.finishReason;
        break;
    }
  }
  return out;
}
