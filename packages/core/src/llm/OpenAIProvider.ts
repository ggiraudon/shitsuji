import { BaseLLMProvider } from './BaseLLMProvider.js';
import { type LLMCompletionOptions, type LLMResponse, type LLMChunk } from './types.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call?: {
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  };
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export class OpenAIProvider extends BaseLLMProvider {
  readonly name = 'openai';
  private apiKey: string;
  private baseUrl = 'https://api.openai.com/v1';
  private defaultModel = 'gpt-4o';

  constructor(apiKey: string, options?: { baseUrl?: string; defaultModel?: string }) {
    super();
    this.apiKey = apiKey;
    if (options?.baseUrl) this.baseUrl = options.baseUrl;
    if (options?.defaultModel) this.defaultModel = options.defaultModel;
  }

  async complete(options: LLMCompletionOptions): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    this.logRequest(options);

    const messages: OpenAIMessage[] = options.messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId,
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }

      if (msg.role === 'assistant' && msg.toolName && msg.toolCallId) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_call: {
            id: msg.toolCallId,
            type: 'function' as const,
            function: {
              name: msg.toolName,
              arguments: msg.content,
            },
          },
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
        name: msg.name,
      };
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      id: string;
      model: string;
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices[0];
    if (!choice) {
      throw new Error(`OpenAI API returned no choices (response id ${data.id})`);
    }
    const llmResponse: LLMResponse = {
      id: data.id,
      model: data.model,
      content: choice.message.content ?? '',
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      finishReason: choice.finish_reason as LLMResponse['finishReason'],
    };

    if (choice.message.tool_calls?.length) {
      llmResponse.toolCalls = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
    }

    this.logResponse(llmResponse);
    return llmResponse;
  }

  override async *stream(options: LLMCompletionOptions): AsyncIterable<LLMChunk> {
    const model = options.model ?? this.defaultModel;
    this.logRequest(options);

    const messages: OpenAIMessage[] = options.messages.map((msg) => ({
      role: msg.role === 'tool' ? 'tool' : msg.role,
      content: msg.content,
      name: msg.name,
      tool_call_id: msg.toolCallId,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    };

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        if (trimmed === 'data: [DONE]') return;

        try {
          const data = JSON.parse(trimmed.slice(6)) as {
            id: string;
            choices: Array<{
              delta: {
                content?: string;
                tool_calls?: Array<{
                  id: string;
                  function: { name: string; arguments: string };
                }>;
              };
            }>;
          };

          const choice = data.choices[0];
          if (!choice) continue;

          yield {
            id: data.id,
            delta: choice.delta.content ?? '',
            toolCalls: choice.delta.tool_calls?.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments),
            })),
          };
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }

  getModels(): string[] {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
  }
}
