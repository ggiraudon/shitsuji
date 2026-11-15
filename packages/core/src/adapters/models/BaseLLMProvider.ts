import {
  type LLMProvider,
  type LLMCompletionOptions,
  type LLMResponse,
  type LLMChunk,
} from '../../ports/LLMProvider.js';
import type { Logger } from '../../ports/Logger.js';

export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;

  constructor(protected readonly log: Logger) {}

  abstract complete(options: LLMCompletionOptions): Promise<LLMResponse>;

  stream?(options: LLMCompletionOptions): AsyncIterable<LLMChunk>;

  abstract getModels(): string[];

  protected logRequest(options: LLMCompletionOptions): void {
    this.log.debug('LLM Request', {
      model: options.model ?? this.name,
      messageCount: options.messages.length,
      hasTools: !!options.tools?.length,
    });
  }

  protected logResponse(response: LLMResponse): void {
    this.log.debug('LLM Response', {
      model: response.model,
      contentLength: response.content.length,
      toolCalls: response.toolCalls?.length ?? 0,
      usage: response.usage,
    });
  }
}
