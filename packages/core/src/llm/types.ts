export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'tool_use' | 'content_filter' | null;
}

export interface LLMChunk {
  id: string;
  delta: string;
  toolCalls?: ToolCall[];
}

export interface LLMCompletionOptions {
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMProvider {
  readonly name: string;
  complete(options: LLMCompletionOptions): Promise<LLMResponse>;
  stream?(options: LLMCompletionOptions): AsyncIterable<LLMChunk>;
  getModels(): string[];
}
