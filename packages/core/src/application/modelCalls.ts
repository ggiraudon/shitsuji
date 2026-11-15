import type { ToolCall } from '../domain/model/Message.js';
import type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  TokenUsage,
} from '../ports/ModelProvider.js';

export interface ModelResponse {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
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
