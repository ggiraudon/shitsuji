import { BaseLLMProvider } from './BaseLLMProvider.js';
import { type LLMCompletionOptions, type LLMResponse, type LLMChunk } from './types.js';
import { logger } from '../utils/logger.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private baseUrl = 'https://api.anthropic.com/v1';
  private defaultModel = 'claude-3-5-sonnet-20241022';

  constructor(apiKey: string, options?: { baseUrl?: string; defaultModel?: string }) {
    super();
    this.apiKey = apiKey;
    if (options?.baseUrl) this.baseUrl = options.baseUrl;
    if (options?.defaultModel) this.defaultModel = options.defaultModel;
  }

  async complete(options: LLMCompletionOptions): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    this.logRequest(options);

    const messages: AnthropicMessage[] = options.messages
      .filter(m => m.role !== 'system')
      .slice(-20)
      .map(msg => ({
        role: (msg.role === 'tool' ? 'user' : msg.role) as 'user' | 'assistant',
        content: msg.role === 'tool' 
          ? `[Tool result: ${msg.toolCallId}] ${msg.content}`
          : msg.content,
      }));

    const systemMessage = options.messages.find(m => m.role === 'system');

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    if (options.tools?.length) {
      body.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string | null;
    };

    const textContent = data.content.find(c => c.type === 'text');
    const toolUseContents = data.content.filter(c => c.type === 'tool_use' && 'id' in c && 'name' in c && 'input' in c);

    const llmResponse: LLMResponse = {
      id: data.id,
      model: data.model,
      content: textContent?.text ?? '',
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      finishReason: data.stop_reason as LLMResponse['finishReason'],
    };

    if (toolUseContents.length > 0) {
      llmResponse.toolCalls = toolUseContents.map(tu => {
        const t = tu as unknown as { id: string; name: string; input: Record<string, unknown> };
        return {
          id: t.id,
          name: t.name,
          arguments: t.input ?? {},
        };
      });
    }

    this.logResponse(llmResponse);
    return llmResponse;
  }

  // Stub until the adapter is rewritten in S12; yields nothing.
  // eslint-disable-next-line require-yield
  async *stream(_options: LLMCompletionOptions): AsyncIterable<LLMChunk> {
    logger.warn('Streaming not yet implemented for Anthropic');
    return;
  }

  getModels(): string[] {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ];
  }
}
