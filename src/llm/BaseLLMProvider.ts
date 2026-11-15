import { type LLMProvider, type LLMCompletionOptions, type LLMResponse, type LLMChunk } from './types.js';
import { logger } from '../utils/logger.js';

export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;
  
  abstract complete(options: LLMCompletionOptions): Promise<LLMResponse>;
  
  stream?(options: LLMCompletionOptions): AsyncIterable<LLMChunk>;
  
  abstract getModels(): string[];
  
  protected logRequest(options: LLMCompletionOptions): void {
    logger.debug('LLM Request', {
      model: options.model ?? this.name,
      messageCount: options.messages.length,
      hasTools: !!options.tools?.length,
    });
  }
  
  protected logResponse(response: LLMResponse): void {
    logger.debug('LLM Response', {
      model: response.model,
      contentLength: response.content.length,
      toolCalls: response.toolCalls?.length ?? 0,
      usage: response.usage,
    });
  }
}
