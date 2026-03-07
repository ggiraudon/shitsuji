# Project Overview: Seahorse - AI Agent Framework

## 1. Project Vision

Seahorse is a lightweight, TypeScript-based AI agent framework designed for simplicity and understandability. Inspired by OpenClaw but built from scratch with a focus on clean OOP principles and event-driven architecture.

**Core Philosophy**: An AI agent is fundamentally a loop where triggers (text, events, timers) initiate LLM calls, which may trigger additional calls or tool executions based on rules.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Application                                 │
│                      (Entry Point / CLI)                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │MessageBus│    │ Channels │    │  Tasks   │
    │ (Pub/Sub)│    │ (I/O)    │    │ (Cron)   │
    └────┬─────┘    └────┬─────┘    └────┬─────┘
         │               │               │
         └───────────────┼───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Agent Engine                                   │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐         │
│  │  Agent  │◄──►│ Session │◄──►│ Memory  │◄──►│  LLM    │         │
│  │         │    │         │    │         │    │Provider │         │
│  └────┬────┘    └─────────┘    └─────────┘    └────┬────┘         │
│       │                                            │               │
│       └──────────────────┬─────────────────────────┘               │
│                          ▼                                         │
│                   ┌──────────┐                                      │
│                   │  Tools   │                                      │
│                   └──────────┘                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Agent
The orchestrator that runs the main agent loop.

**Responsibilities**:
- Manage the agent lifecycle (start, stop, reset)
- Execute the思考 loop: receive → process → respond
- Handle tool execution requests
- Manage conversation flow
- Manage multiple concurrent sessions

**Session Management**:
```typescript
class Agent {
  id: string;
  name: string;
  
  // Session management
  sessions: Map<string, Session>;  // sessionId → Session
  activeSession: Session | null;
  
  // Get or create session
  getSession(sessionId: string): Session;
  createSession(): Session;
  
  // End session
  endSession(sessionId: string): void;
}
```

**Key Methods**:
- `run(input: string, sessionId?: string): Promise<Response>`
- `executeTool(toolCall: ToolCall): Promise<ToolResult>`
- `addTool(tool: Tool): void`
- `getSession(sessionId: string): Session`

### 3.2 Session
Maintains conversation state and history for a single conversation thread.

**Responsibilities**:
- Store message history (recent conversation)
- Manage session memory (key facts learned)
- Handle token budget (compression/eviction)
- Track session metadata
- Handle session persistence

**Structure**:
```typescript
class Session {
  // Identity
  id: string;
  agentId: string;
  createdAt: Date;
  updatedAt: Date;
  
  // Message history (within token budget)
  messages: Message[];
  
  // Session memory: key facts learned in this conversation
  // "The user's name is Alice" → "user_name: Alice"
  memory: Map<string, string>;
  
  // Token management
  maxTokens: number;
  usedTokens: number;
  
  // Render for context window injection
  renderForContext(): string;
  
  // Add message, handle compression if needed
  addMessage(msg: Message): void;
  
  // Store important fact
  remember(key: string, value: string): void;
}
```

**Memory Injection via ContextInjectable**:
```typescript
class SessionContextInjectable implements ContextInjectable {
  readonly id = 'session-context';
  readonly priority = 10;  // After identity, before tools
  readonly condition = { type: 'always' };
  
  render(): string {
    const session = this.getCurrentSession();
    return session.renderForContext();
  }
}
```

**Token Budget Handling**:
- Keep last N messages that fit in context
- Or compress old messages into summary
- Track `usedTokens` to prevent overflow

**Session Lifecycle**:
```
Session Created ──► Active ──► Ended (timeout/inactive)
     │                   │
     └─ session:created  └─ session:ended (MessageBus)
```

**Key Properties**:
- `id: string`
- `agentId: string`
- `messages: Message[]`
- `memory: Map<string, string>`
- `createdAt: Date`
- `updatedAt: Date`

### 3.3 LLMProvider
Abstraction layer for LLM APIs.

**Responsibilities**:
- Unified interface for different LLM backends
- Request/response transformation
- Streaming support
- Token counting and limits

**Interface**:
```typescript
interface LLMProvider {
  complete(prompt: Prompt): Promise<LLMResponse>;
  stream(prompt: Prompt): AsyncIterable<Chunk>;
  getName(): string;
}
```

**Supported Providers** (initial):
- OpenAI (GPT-4, GPT-4o)
- Anthropic (Claude 3.5)
- Local/Ollama (future)

### 3.4 Tool
Executable capabilities the agent can use.

**Responsibilities**:
- Define tool schema (JSON Schema)
- Validate input parameters
- Execute the tool logic
- Return formatted results

**Structure**:
```typescript
abstract class Tool {
  name: string;
  description: string;
  schema: JSONSchema;
  
  abstract execute(params: unknown): Promise<ToolResult>;
}
```

**Initial Tools**:
- `WebSearchTool` - Search the web
- `CalculatorTool` - Mathematical operations
- `FileReadTool` - Read files
- `FileWriteTool` - Write files
- `ExecuteCommandTool` - Run shell commands

### 3.5 Task
Scheduled or triggered background work.

**Responsibilities**:
- Define repeatable tasks
- Manage cron-like scheduling
- Execute in background
- Report results

### 3.6 Channel
Abstract message transport layer.

**Responsibilities**:
- Receive incoming messages
- Send outgoing messages
- Format for platform specifics
- Handle authentication

**Interface**:
```typescript
interface Channel {
  name: string;
  send(destination: string, message: Message): Promise<void>;
  onMessage(handler: (message: Message) => void): void;
}
```

**Initial Channels**:
- `CLIChannel` - Terminal I/O
- `WebhookChannel` - HTTP webhooks
- (Extensible for Telegram, Slack, Discord later)

### 3.7 Prompt
Prompt template management.

**Responsibilities**:
- Build system prompts
- Template variable substitution
- Prompt versioning
- Context injection

### 3.8 Memory
Persistent storage and retrieval.

**Responsibilities**:
- Store conversation history
- Semantic search (vector)
- Long-term memory
- Context summarization

**Initial Implementation**: In-memory (easier to understand), with SQLite persistence.

### 3.9 ContextInjectable
Composable context pieces injected into the LLM context window.

**Problem**: Managing what gets injected into the prompt without hardcoding rules.

**Responsibilities**:
- Define pieces of context that can be conditionally injected
- Support different injection conditions (always, on tool use, on pattern match)
- Render to text for inclusion in prompt
- Priority-based ordering

**Interface**:
```typescript
interface ContextInjectable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priority: number;  // Higher = injected first
  readonly condition: InjectionCondition;
  
  render(): string | null;  // Returns text to inject, null to skip
}

type InjectionCondition =
  | { type: 'always' }
  | { type: 'tool_used', toolNames: string[] }
  | { type: 'pattern_detected', pattern: RegExp }
  | { type: 'custom', check: (context: AgentContext) => boolean }
  | { type: 'once' }  // Only inject once per session
```

**Built-in Injectables**:

| Injectable | Condition | Example Output |
|------------|-----------|----------------|
| `AgentIdentity` | always | "You are Seahorse, a helpful AI assistant..." |
| `ToolList` | always | "Available tools: web_search, calculator..." |
| `SafetyRules` | always | "Never reveal personal information..." |
| `ToolContext` | on tool use | "You are currently using calculator. Format: ..." |
| `PrivacyGuard` | on pattern match | "PII detected - redact before responding..." |
| `SessionSummary` | on long conversation | Summary of conversation so far |

**Usage in Agent**:
```typescript
class Agent {
  private injectables: ContextInjectable[] = [];

  addInjectable(injectable: ContextInjectable) {
    this.injectables.push(injectable);
    this.injectables.sort((a, b) => b.priority - a.priority);
  }

  buildContext(ctx: AgentContext): string {
    return this.injectables
      .filter(i => this.checkCondition(i.condition, ctx))
      .map(i => i.render())
      .filter((s): s is string => s !== null)
      .join('\n\n');
  }
}
```

**Initial Injectables**:
- `IdentityInjectable` - Agent name, description, capabilities
- `ToolListInjectable` - List of available tools with descriptions
- `RulesInjectable` - Safety guidelines, behavioral rules

---

## 4. MessageBus (Pub/Sub)

Central message bus for loose coupling between components using publish/subscribe.

### Why a MessageBus?

- **Decoupling**: Components don't know about each other, only the bus
- **Extensibility**: Add new subscribers without modifying publishers
- **Debugging**: Easy to trace message flow
- **Testing**: Simple to mock or spy on messages

### Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Publisher  │────►│   MessageBus │────►│  Subscriber │
│             │     │              │     │             │
│ - Agent     │     │  ┌────────┐  │     │ - Channels  │
│ - Channels  │     │  │Topics  │  │     │ - Tools     │
│ - Tasks     │     │  │Queue   │  │     │ - Memory    │
│ - Tools     │     │  └────────┘  │     │ - Logger    │
└─────────────┘     └──────────────┘     └─────────────┘
```

### Topics

```typescript
// Topic categories: <domain>.<action>

// Agent lifecycle
'agent.start' | 'agent.stop' | 'agent.reset'

// Message flow
'message.received' | 'message.sent' | 'message.error'

// LLM interaction
'llm.request' | 'llm.response' | 'llm.chunk' | 'llm.error'

// Tool execution
'tool.called' | 'tool.start' | 'tool.result' | 'tool.error'

// Session events
'session.created' | 'session.updated' | 'session.ended'

// System
'system.error' | 'system.ready'
```

### Interface

```typescript
interface MessageBus {
  // Publish a message to a topic
  publish<T>(topic: string, payload: T): void;

  // Subscribe to a topic (returns unsubscribe function)
  subscribe<T>(topic: string, handler: (payload: T) => void): () => void;

  // Subscribe to multiple topics or wildcard
  subscribeMany(topics: string[], handler: (topic: string, payload: unknown) => void): () => void;

  // Get all subscribers for a topic (useful for debugging)
  getSubscribers(topic: string): number;
}
```

### Message Format

```typescript
interface Message<T = unknown> {
  topic: string;
  payload: T;
  timestamp: number;
  source?: string;
  traceId?: string;  // For request tracing
}
```

### Usage Examples

```typescript
// Publisher (Agent)
messageBus.publish('llm.request', {
  prompt: 'Hello',
  model: 'gpt-4'
});

// Subscriber (Logger)
const unsub = messageBus.subscribe('llm.response', (payload) => {
  logger.info('LLM responded', { tokens: payload.usage });
});

// Subscriber (Channel - respond to user)
messageBus.subscribe('agent.response', async ({ sessionId, text }) => {
  const session = sessionManager.get(sessionId);
  await session.channel.send(session.destination, text);
});
```

### Implementation Notes

- **Synchronous by default**: Handlers run in the same tick (simpler)
- **Error handling**: Wrap each handler in try/catch, emit to `system.error` on failure
- **No persistence**: In-memory only (messages are "fire and forget")
- **No ordering guarantee**: Subscribers may process in any order
- **Optional**: For very simple cases, direct function calls are fine

---

## 5. The Agent Loop

```
┌─────────────┐
│   Trigger   │
│ (message/   │
│  event/     │
│   timer)    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Build     │
│   Context   │◄──── (ContextInjectables)
│ (system +   │
│  user msg)  │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐
│   Build     │────►│   Call LLM  │
│   Prompt    │     │   Provider  │
└─────────────┘     └──────┬──────┘
                           │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Response │    │  Tool    │    │  Error   │
   │  (text)  │    │  Call    │    │ Handling │
   └────┬─────┘    └────┬─────┘    └──────────┘
        │              │
        │              ▼
        │       ┌─────────────┐
        │       │   Execute   │
        │       │    Tool     │
        │       └──────┬──────┘
        │              │
        │              ▼
        │       ┌─────────────┐
        └──────►│  Continue   │────► (loop back to LLM)
                │  Loop?      │
                └─────────────┘
                       │
                       ▼
                ┌─────────────┐
                │   Deliver   │
                │  Response   │
                └─────────────┘
```

---

## 6. Project Structure

```
seahorse/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli.ts                # CLI interface (OpenTUI)
│   │
│   ├── core/
│   │   ├── Agent.ts          # Main agent class
│   │   ├── Session.ts        # Session management
│   │   ├── Task.ts           # Task/scheduler
│   │   └── MessageBus.ts     # Pub/sub message bus
│   │
│   ├── llm/
│   │   ├── LLMProvider.ts    # Provider interface
│   │   ├── OpenAIProvider.ts # OpenAI implementation
│   │   ├── AnthropicProvider.ts
│   │   └── types.ts          # LLM types
│   │
│   ├── tools/
│   │   ├── Tool.ts           # Base tool class
│   │   ├── Registry.ts       # Tool registration
│   │   └── implementations/  # Tool implementations
│   │       ├── WebSearch.ts
│   │       ├── Calculator.ts
│   │       └── FileSystem.ts
│   │
│   ├── memory/
│   │   ├── Memory.ts         # Memory interface
│   │   └── InMemory.ts       # In-memory implementation
│   │
│   ├── channels/
│   │   ├── Channel.ts        # Channel interface
│   │   ├── CLIChannel.ts     # Terminal channel (OpenTUI)
│   │   └── WebhookChannel.ts
│   │
│   ├── prompts/
│   │   ├── Prompt.ts         # Prompt builder
│   │   ├── templates/        # System prompts
│   │   └── context/          # ContextInjectables
│   │
│   ├── tui/                  # Terminal UI (Ink/React)
│   │   ├── App.tsx           # Main TUI app
│   │   ├── components/       # UI components
│   │   └── theme.ts         # One-dark theme
│   │
│   └── utils/
│       ├── logger.ts
│       └── config.ts
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## 7. Technology Choices

### Runtime & Language
- **Node.js 22+** (ESM modules)
- **TypeScript 5.x** (strict mode)

### Key Dependencies
| Package | Purpose |
|---------|---------|
| `typescript` | Type safety |
| `tsx` | Run TypeScript directly |
| `ink` | Terminal UI (React-based, Node.js compatible) |
| `react` | UI framework for Ink |
| `zod` | Schema validation |
| `dotenv` | Environment config |
| `hono` | HTTP server (webhooks) |
| `tsup` or `tsx` | Bundle plugins |

### Terminal UI - One Dark Theme

We use **Ink** for terminal UI (Node.js compatible). We'll customize the theme to match OpenCode's one-dark look.

```typescript
import { render, Box, Text } from 'ink';

const App = () => (
  <Box borderStyle="round" borderColor="green">
    <Text>Hello, Seahorse!</Text>
  </Box>
);

render(<App />);
```

One-dark color palette:
```typescript
const colors = {
  background: '#1e1e1e',
  foreground: '#abb2bf',
  accent: '#61afef',      // Blue
  success: '#98c379',     // Green  
  error: '#e06c75',       // Red
  warning: '#e5c07b',     // Yellow
  purple: '#c678dd',
};
```

### Testing
- **Vitest** - Unit and integration tests

### Linting/Formatting
- **oxlint** or **eslint** + **prettier**

---

## 8. Plugin System

Extensible architecture for Channels, LLM Providers, and Tools.

### Why Plugins?

- Add new channels without modifying core code (Telegram, Slack, Discord, etc.)
- Support new LLM providers (OpenAI, Anthropic, Ollama, etc.)
- Extend tools without rebuilding
- Third-party contributions

### Plugin Architecture

```typescript
// Base plugin interface
interface Plugin {
  readonly manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void>;
  destroy(): Promise<void>;
}

interface PluginManifest {
  id: string;           // unique identifier
  name: string;
  version: string;
  type: 'channel' | 'llm' | 'tool';
  description?: string;
  dependencies?: string[];
}
```

### Plugin Types

```typescript
// Channel plugin - adds a new message transport
interface ChannelPlugin extends Plugin {
  manifest: { type: 'channel' };
  createChannel(config: ChannelConfig): Promise<Channel>;
}

// LLM plugin - adds a new model provider
interface LLMPlugin extends Plugin {
  manifest: { type: 'llm' };
  createProvider(config: LLMConfig): Promise<LLMProvider>;
}

// Tool plugin - adds new capabilities
interface ToolPlugin extends Plugin {
  manifest: { type: 'tool' };
  createTool(): Promise<Tool>;
}
```

### Plugin Manager

```typescript
class PluginManager {
  private plugins = new Map<string, Plugin>();
  
  // Load from directory or npm
  async load(path: string): Promise<void>;
  async loadNpm(name: string): Promise<void>;
  
  // Registry
  register(plugin: Plugin): void;
  unregister(id: string): void;
  
  // Access
  getChannel(id: string): Channel;
  getProvider(id: string): LLMProvider;
  getTool(id: string): Tool;
  
  // List all
  listChannels(): ChannelPlugin[];
  listProviders(): LLMPlugin[];
  listTools(): ToolPlugin[];
}
```

### Plugin Discovery

| Source | Example | Loading |
|--------|---------|---------|
| Local folder | `plugins/telegram/` | `load('./plugins/telegram')` |
| NPM package | `seahorse-plugin-slack` | `loadNpm('seahorse-plugin-slack')` |

### Plugin Lifecycle

```
Discovery → Load → Init → Ready → (use) → Destroy
```

### Project Structure with Plugins

```
seahorse/
├── src/
│   ├── core/                  # Core system
│   ├── plugins/               # Built-in plugins
│   │   ├── channel/
│   │   │   ├── cli/
│   │   │   └── webhook/
│   │   ├── llm/
│   │   │   ├── openai/
│   │   │   └── anthropic/
│   │   └── tool/
│   │       ├── calculator/
│   │       └── filesystem/
│   └── ...
├── plugins/                   # User plugins (gitignored)
└── seahorse.config.json
```

---

## 9. Design Principles

1. **Single Responsibility**: Each class has one clear purpose
2. **Dependency Injection**: Modules depend on interfaces, not implementations
3. **Event-Driven**: Components communicate via events, not direct calls
4. **Interface First**: Define contracts before implementations
5. **Favor Composition**: Prefer composition over deep inheritance
6. **Configuration over Convention**: Explicit over implicit

---

## 10. Implementation Phases

### Phase 1: Foundation
- [ ] Project setup (Node.js, TypeScript, ESLint, Vitest)
- [ ] Install Ink + React
- [ ] Basic TUI app with one-dark theme
- [ ] PluginManager + Plugin interface
- [ ] MessageBus implementation
- [ ] Basic config management
- [ ] Logger utility

### Phase 2: Core Agent
- [ ] LLMProvider interface + OpenAI implementation
- [ ] Session class
- [ ] ContextInjectable interface + basic injectables (identity, tools, rules)
- [ ] Agent class with basic loop
- [ ] Message handling

### Phase 3: Tool System
- [ ] Tool base class + registry
- [ ] 2-3 basic tools (calculator, echo, file read)
- [ ] Tool execution in agent loop

### Phase 4: Channels & I/O
- [ ] CLI channel (interactive terminal)
- [ ] Webhook channel (HTTP endpoints)

### Phase 5: Memory & Persistence
- [ ] In-memory message store
- [ ] Session persistence to JSON file

### Phase 6: Advanced Features
- [ ] Additional LLM providers (Anthropic)
- [ ] More tools
- [ ] Semantic memory (optional)

---

## 10. Key Differences from OpenClaw

| Aspect | OpenClaw | Seahorse |
|--------|----------|----------|
| Size | ~500 files | ~20-30 files |
| Channels | 40+ built-in | CLI + Webhook (extensible) |
| Memory | Vector DB (LanceDB) | In-memory + JSON |
| Architecture | Monorepo | Single package |
| Complexity | Enterprise-grade | Learning-focused |
| Subagents | Full subagent system | Simplified (optional) |
| Skills | Plugin system | Simple tool registry |
| WebSocket | Built-in | Minimal HTTP |

---

## 11. Next Steps

1. Review this architecture
2. Confirm core components and responsibilities
3. Start Phase 1: Project setup
4. Implement MessageBus and core types
5. Build minimal Agent + LLMProvider + Session loop

---

*This document will evolve as we implement and learn.*
