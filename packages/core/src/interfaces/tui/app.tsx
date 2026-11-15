import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { Agent } from '../../application/Agent.js';
import { OpenAIProvider } from '../../adapters/models/OpenAIProvider.js';
import { AnthropicProvider } from '../../adapters/models/AnthropicProvider.js';
import { CalculatorTool } from '../../adapters/tools/CalculatorTool.js';
import { WebSearchTool } from '../../adapters/tools/WebSearchTool.js';
import { FileReadTool, FileWriteTool, FileListTool } from '../../adapters/tools/FileSystemTool.js';
import { ExecuteCommandTool } from '../../adapters/tools/ExecuteCommandTool.js';
import { SystemInfoTool } from '../../adapters/tools/SystemInfoTool.js';
import { SessionStore } from '../../adapters/storage/SessionStore.js';
import { join } from 'path';
import { configManager } from '../../composition/config.js';
import type { Logger } from '../../ports/Logger.js';
import type { EventBus } from '../../ports/EventBus.js';

export interface TuiServices {
  log: Logger;
  events: EventBus;
}

const colors = {
  background: '#1e1e1e',
  foreground: '#abb2bf',
  accent: '#61afef',
  success: '#98c379',
  error: '#e06c75',
  warning: '#e5c07b',
  purple: '#c678dd',
  cyan: '#56b6c2',
  dim: '#5c6370',
};

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

const ShitsujiApp = ({ services }: { services: TuiServices }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initAgent();
  }, []);

  const initAgent = async () => {
    try {
      const configDir = configManager.getConfigDir();
      const dataDir = join(configDir, 'data');

      const openaiKey = process.env.OPENAI_API_KEY;
      const anthropicKey = process.env.ANTHROPIC_API_KEY;

      let llm;
      let model = 'gpt-4o-mini';

      if (anthropicKey) {
        llm = new AnthropicProvider(anthropicKey, services.log);
        model = 'claude-3-5-sonnet-20241022';
      } else if (openaiKey) {
        llm = new OpenAIProvider(openaiKey, services.log);
      } else {
        setError('No API key set (OPENAI_API_KEY or ANTHROPIC_API_KEY)');
        return;
      }

      const sessionStore = new SessionStore(join(dataDir, 'sessions'), services.log);

      const newAgent = new Agent({
        name: 'Shitsuji',
        llmProvider: llm,
        model,
        sessionStore,
        log: services.log,
        events: services.events,
      });

      newAgent.registerTool(new CalculatorTool());
      newAgent.registerTool(new WebSearchTool());
      newAgent.registerTool(new FileReadTool());
      newAgent.registerTool(new FileWriteTool());
      newAgent.registerTool(new FileListTool());
      newAgent.registerTool(new ExecuteCommandTool());
      newAgent.registerTool(new SystemInfoTool());

      const session = newAgent.createSession();

      setAgent(newAgent);
      setSessionId(session.id);

      addMessage('system', 'Shitsuji initialized. Type your message and press Enter.');
    } catch (err) {
      setError(String(err));
    }
  };

  const addMessage = (role: Message['role'], content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}`,
        role,
        content,
        timestamp: Date.now(),
      },
    ]);
  };

  const handleSubmit = async () => {
    if (!input.trim() || isProcessing || !agent || !sessionId) return;

    const userInput = input.trim();
    setInput('');
    setIsProcessing(true);

    addMessage('user', userInput);
    addMessage('assistant', '...');

    try {
      const response = await agent.send(userInput, sessionId);

      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.findLastIndex((m) => m.content === '...');
        if (lastIdx >= 0) {
          updated[lastIdx] = {
            id: `${Date.now()}`,
            role: 'assistant',
            content: response,
            timestamp: Date.now(),
          };
        }
        return updated;
      });
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.findLastIndex((m) => m.content === '...');
        if (lastIdx >= 0) {
          updated[lastIdx] = {
            id: `${Date.now()}`,
            role: 'assistant',
            content: `Error: ${String(err)}`,
            timestamp: Date.now(),
          };
        }
        return updated;
      });
    }

    setIsProcessing(false);
  };

  useInput((input, key) => {
    if (key.return) {
      handleSubmit();
    } else if (key.backspace) {
      setInput((prev) => prev.slice(0, -1));
    } else if (key.ctrl && input === 'c') {
      process.exit(0);
    } else if (input) {
      setInput((prev) => prev + input);
    }
  });

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box borderStyle="round" borderColor={colors.error} padding={1}>
          <Text color={colors.error}>Error: {error}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.accent}
        padding={1}
        minHeight={3}
      >
        <Text bold color={colors.accent}>
          ╔════════════════════════════════════════╗
        </Text>
        <Text bold color={colors.accent}>
          ║ Shitsuji AI Agent ║
        </Text>
        <Text bold color={colors.accent}>
          ╚════════════════════════════════════════╝
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {messages.map((msg) => (
          <Box key={msg.id} flexDirection="column" paddingY={0}>
            <Text
              bold
              color={
                msg.role === 'user'
                  ? colors.cyan
                  : msg.role === 'assistant'
                    ? colors.success
                    : colors.warning
              }
            >
              {msg.role === 'user' ? 'You:' : msg.role === 'assistant' ? 'Shitsuji:' : 'System:'}
            </Text>
            <Text>{msg.content}</Text>
            <Text color={colors.dim}>{'─'.repeat(50)}</Text>
          </Box>
        ))}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isProcessing ? colors.warning : colors.purple}
        padding={1}
      >
        <Text color={colors.purple}>{isProcessing ? 'Processing...' : `> ${input || '_'}`}</Text>
      </Box>
    </Box>
  );
};

export async function startTUI(services: TuiServices): Promise<void> {
  render(<ShitsujiApp services={services} />);
}
