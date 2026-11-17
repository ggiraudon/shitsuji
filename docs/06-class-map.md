# Class map

A picture of the **target** code structure, gathered from the feature files. This is speculative: it shows
the shape we are aiming for, not code that exists. Names come from the feature docs. The few names that
appear only here are marked *(named here)*.

One diagram per area, because a single diagram with ~150 classes is unreadable. Each section links to the
feature file that explains it.

## How to read the diagrams

| Arrow | Meaning |
|-------|---------|
| `A <\|-- B` (solid, hollow triangle) | B **extends** A |
| `A <\|.. B` (dashed, hollow triangle) | B **implements** interface A |
| `A *-- B` (filled diamond) | A **owns** B (B lives and dies with A) |
| `A o-- B` (hollow diamond) | A **holds** a list of B (B lives elsewhere) |
| `A --> B` | A **uses** B (a dependency injected into A) |
| `A ..> B` | A **creates or returns** B |

`<<interface>>` marks a **port** (in `src/ports`). Classes that implement a port are **adapters** (in
`src/adapters`). Everything else is **application** code (in `src/application`) or **domain** (in `src/domain`).

## 0. Layers

The rule that holds the structure together: arrows only point inwards. Domain knows nothing; adapters know
the ports they implement; only the composition root knows everything.

```mermaid
flowchart TB
  comp["composition/<br/>createShitsuji · loadConfig"] --> iface & app & adapters & plugins
  iface["interfaces/<br/>HTTP API · WebSocket · CLI · TUI"] --> app
  plugins["plugins/<br/>built-in + user plugins"] --> ports
  adapters["adapters/<br/>Postgres · OpenAI-compatible · Telegram · Docker · CDP · IMAP …"] --> ports
  app["application/<br/>runtime · trust · memory · tools · tasks · scheduler …"] --> ports & domain
  ports["ports/<br/>interfaces only"] --> domain
  domain["domain/<br/>Thread · Session · Turn · Task · Approval …"]
```

## 1. Composition root and plugins

[F01](features/F01-core-architecture.md)

```mermaid
classDiagram
  direction LR
  class Shitsuji {
    +start()
    +stop()
  }
  class createShitsuji {
    <<function>>
    +createShitsuji(config) Shitsuji
  }
  class ShitsujiConfig {
    <<zod schema>>
  }
  class PluginManager {
    +loadBuiltIns(plugins)
    +loadFromDirectory(dir)
    +providers() ModelProvider[]
    +channels() ChannelAdapter[]
    +tools() Tool[]
    +computers() ComputerBackend[]
  }
  class ShitsujiPlugin {
    <<interface>>
    +manifest PluginManifest
    +register(ctx)
    +dispose()
  }
  class PluginRegistrationContext {
    <<interface>>
    +addModelProvider(p)
    +addChannel(c)
    +addTools(t)
    +addComputer(c)
    +addContextInjectable(i)
  }
  class EventBus {
    <<interface>>
    +publish(type, payload)
    +subscribe(type, handler)
    +subscribePattern(pattern, handler)
  }
  class InProcessEventBus
  class Logger {
    <<interface>>
  }
  class JsonLogger
  class PrettyLogger
  class Clock {
    <<interface>>
  }
  class SystemClock
  class ShitsujiError {
    +code
    +details
  }
  class ProviderError
  class ToolInputError
  class PolicyDenied
  class SandboxUnavailable

  createShitsuji ..> Shitsuji
  createShitsuji --> ShitsujiConfig
  createShitsuji --> PluginManager
  PluginManager o-- ShitsujiPlugin
  ShitsujiPlugin --> PluginRegistrationContext
  Shitsuji *-- TurnRunner
  Shitsuji *-- ChannelGateway
  Shitsuji *-- JobQueue
  Shitsuji --> EventBus
  EventBus <|.. InProcessEventBus
  Logger <|.. JsonLogger
  Logger <|.. PrettyLogger
  Clock <|.. SystemClock
  ShitsujiError <|-- ProviderError
  ShitsujiError <|-- ToolInputError
  ShitsujiError <|-- PolicyDenied
  ShitsujiError <|-- SandboxUnavailable
```

## 2. Domain model

[F02](features/F02-persistence.md), [F04](features/F04-agent-runtime.md), [F11](features/F11-trust-and-approvals.md),
[F15](features/F15-tasks-and-subagents.md). Plain objects with state machines; no I/O.

```mermaid
classDiagram
  direction LR
  class Owner {
    +id
    +timeZone
  }
  class Thread {
    +id
    +ownerId
    +archivedAt
  }
  class Session {
    +id
    +kind
    +profileId
  }
  class SessionKind {
    <<enumeration>>
    chat
    task
    helper
    schedule
    observer
  }
  class Turn {
    +id
    +state
    +trigger
    +transition(to)
  }
  class TurnState {
    <<enumeration>>
    queued
    running
    waiting
    succeeded
    failed
    cancelled
  }
  class StoredMessage {
    +role
    +content
    +channel
    +withdrawn
  }
  class Task {
    +id
    +title
    +state
    +parentTaskId
  }
  class Approval {
    +actionHash
    +state
    +question
  }
  class ApprovalState {
    <<enumeration>>
    pending
    approved
    declined
    expired
    uncertain
  }
  class ActionRequest {
    <<command>>
    +tool
    +args
    +effect
    +target
    +hash()
  }
  class Matter {
    +sourceRecord
    +condition
    +status
  }

  Owner "1" *-- "1" Thread : one live thread
  Thread "1" *-- "many" Session
  Session --> SessionKind
  Session "1" *-- "many" Turn
  Turn --> TurnState
  Session "1" *-- "many" StoredMessage
  Task "1" --> "1" Session : runs in
  Task o-- Task : sub-tasks
  Turn "1" o-- "0..1" Approval : waits on
  Approval --> ApprovalState
  Approval --> ActionRequest : bound to exactly
  Owner "1" o-- "many" Matter
```

## 3. Model providers

[F03](features/F03-model-providers.md), [F22](features/F22-observability-and-cost.md). Strategy (one provider per
endpoint) plus Decorator (metering, retries, redaction wrap any provider).

```mermaid
classDiagram
  direction LR
  class ModelProvider {
    <<interface>>
    +id
    +stream(request, signal) ModelStreamEvent[]
    +listModels() ModelInfo[]
  }
  class OpenAICompatibleProvider {
    +baseUrl
    +quirks
  }
  class AnthropicProvider
  class OllamaNativeProvider {
    later
  }
  class ModelProviderDecorator {
    <<abstract>>
    #inner ModelProvider
  }
  class MeteredModelProvider
  class RetryingModelProvider
  class RedactingModelProvider
  class ModelRouter {
    +forPurpose(purpose) ModelBinding
    +fallbacks(purpose)
  }
  class ModelPurpose {
    <<enumeration>>
    chat
    task
    helper
    classify
    summarize
    vision
    embed
    trust
  }
  class ModelInfo {
    +ref
    +contextWindow
    +capabilities
    +prices
  }
  class SpeechToText {
    <<interface>>
  }
  class TextToSpeech {
    <<interface>>
  }

  ModelProvider <|.. OpenAICompatibleProvider
  ModelProvider <|.. AnthropicProvider
  ModelProvider <|.. OllamaNativeProvider
  ModelProvider <|.. ModelProviderDecorator
  ModelProviderDecorator <|-- MeteredModelProvider
  ModelProviderDecorator <|-- RetryingModelProvider
  ModelProviderDecorator <|-- RedactingModelProvider
  ModelProviderDecorator o-- ModelProvider : wraps
  ModelRouter o-- ModelProvider
  ModelRouter --> ModelPurpose
  ModelRouter o-- ModelInfo : catalogue
  MeteredModelProvider --> UsageLedger
  RedactingModelProvider --> Redactor
```

`ModelProviderDecorator` is *(named here)*: the docs name the three decorators but not their shared base.
Speech ports from [F23](features/F23-voice.md) sit beside the model ports and are metered the same way.

## 4. Agent runtime

[F04](features/F04-agent-runtime.md). Template Method (`TurnRunner` fixes the turn's steps), Composite
(`ContextBuilder` is made of `ContextInjectable`s), State (`Turn`).

```mermaid
classDiagram
  direction LR
  class ThreadService {
    +currentThread(owner) Thread
    +reset(owner)
  }
  class TurnScheduler {
    +onSessionDrain(job)
  }
  class TurnRunner {
    +run(turn, signal)
    #buildContext()
    #callModel()
    #runTools()
    #finish()
  }
  class ContextBuilder {
    +build(session, turn) ModelRequest
  }
  class ContextInjectable {
    <<interface>>
    +id
    +placement
    +order
    +condition
    +render(ctx) string
  }
  class IdentityInjectable
  class SoulInjectable {
    +revision
  }
  class OwnerProfileInjectable
  class ClockInjectable
  class MoodInjectable
  class RulesInjectable
  class ToolIndexInjectable
  class SkillIndexInjectable
  class MemoryIndexInjectable
  class TaskLedgerInjectable
  class ChannelStyleInjectable
  class Compactor {
    +compactIfNeeded(session, turn, transcript, window) Compaction
  }
  class SoulService {
    +current(sessionKind) SoulRevision
    +confirmEdit() SoulRevision
  }
  class SteeringInbox {
    +push(message)
    +drain() StoredMessage[]
  }
  class StopController {
    +signalFor(turnId) AbortSignal
    +stop(turnId)
  }
  class ReplyComposer {
    +interim(update)
    +final(reply)
  }

  TurnScheduler --> TurnRunner
  TurnRunner --> ContextBuilder
  TurnRunner --> SoulService : the turn's revision
  TurnRunner --> ModelRouter
  TurnRunner --> ToolPipeline
  TurnRunner --> SteeringInbox
  TurnRunner --> StopController
  TurnRunner --> ReplyComposer
  TurnRunner --> TurnRepository
  ContextBuilder o-- ContextInjectable
  ContextBuilder --> Compactor
  ContextInjectable <|.. IdentityInjectable
  ContextInjectable <|.. SoulInjectable
  ContextInjectable <|.. OwnerProfileInjectable
  ContextInjectable <|.. ClockInjectable
  ContextInjectable <|.. MoodInjectable
  ContextInjectable <|.. RulesInjectable
  ContextInjectable <|.. ToolIndexInjectable
  ContextInjectable <|.. SkillIndexInjectable
  ContextInjectable <|.. MemoryIndexInjectable
  ContextInjectable <|.. TaskLedgerInjectable
  ContextInjectable <|.. ChannelStyleInjectable
  ReplyComposer --> ChannelGateway
```

## 5. Tools

[F05](features/F05-tool-system.md), [F18](features/F18-integrations-mcp.md), [F20](features/F20-tool-forge.md).
Every tool, whatever its origin, is a `BaseTool`; every call passes the same Chain of Responsibility.

```mermaid
classDiagram
  direction TB
  class BaseTool~I~ {
    <<abstract>>
    +name
    +description
    +inputSchema
    +effect ToolEffect
    +target ToolTarget
    +deferred bool
    +untrustedOutput bool
    +run(input, ctx)*
  }
  class ToolEffect {
    <<enumeration>>
    read
    compute
    write_local
    write_self
    external
  }
  class ToolTarget {
    <<enumeration>>
    core
    workspace
    desktop
    mcp
  }
  class CalculatorTool
  class FileReadTool
  class FileWriteTool
  class FileListTool
  class ExecuteCommandTool
  class SystemInfoTool
  class WebSearchTool
  class BrowserTools {
    browser tools
  }
  class ComputerActTool {
    computer act
  }
  class DesktopInspectTool {
    desktop inspect and act
  }
  class MailTools {
    mail tools
  }
  class McpToolAdapter
  class ForgedTool
  class ToolRegistry {
    +register(tool)
    +select(selectors) BaseTool[]
    +search(query) BaseTool[]
  }
  class ToolPipeline {
    +call(request, ctx) ToolResult
  }
  class ToolMiddleware {
    <<interface>>
    +handle(call, next) ToolResult
  }
  class CancellationMiddleware
  class ValidationMiddleware
  class RepeatFailureMiddleware
  class TrustMiddleware
  class ReceiptMiddleware
  class ExecuteMiddleware
  class OutputLimitMiddleware
  class RedactionMiddleware
  class UntrustedWrapMiddleware
  class SearchProvider {
    <<interface>>
  }

  BaseTool --> ToolEffect
  BaseTool --> ToolTarget
  BaseTool <|-- CalculatorTool
  BaseTool <|-- FileReadTool
  BaseTool <|-- FileWriteTool
  BaseTool <|-- FileListTool
  BaseTool <|-- ExecuteCommandTool
  BaseTool <|-- SystemInfoTool
  BaseTool <|-- WebSearchTool
  BaseTool <|-- BrowserTools
  BaseTool <|-- ComputerActTool
  BaseTool <|-- DesktopInspectTool
  BaseTool <|-- MailTools
  BaseTool <|-- McpToolAdapter
  BaseTool <|-- ForgedTool
  WebSearchTool --> SearchProvider
  ToolRegistry o-- BaseTool
  ToolPipeline --> ToolRegistry
  ToolPipeline o-- ToolMiddleware : ordered chain
  ToolMiddleware <|.. CancellationMiddleware
  ToolMiddleware <|.. ValidationMiddleware
  ToolMiddleware <|.. RepeatFailureMiddleware
  ToolMiddleware <|.. TrustMiddleware
  ToolMiddleware <|.. ReceiptMiddleware
  ToolMiddleware <|.. ExecuteMiddleware
  ToolMiddleware <|.. OutputLimitMiddleware
  ToolMiddleware <|.. RedactionMiddleware
  ToolMiddleware <|.. UntrustedWrapMiddleware
  TrustMiddleware --> TrustService
  ExecuteMiddleware --> WorkspaceBackend
  ExecuteMiddleware --> ComputerBackend
```

`ToolPipeline`, and the grouped classes `BrowserTools`, `ComputerActTool`, `DesktopInspectTool` and `MailTools`,
are *(named here)*: the docs list those tools by name (`browser.click`, `mail.send`, …), and each group will
be several small classes sharing a base.

## 6. Channels

[F06](features/F06-channel-gateway.md), [F07](features/F07-web-ui.md), [F23](features/F23-voice.md). Adapter pattern;
the gateway turns any channel's message into a turn.

```mermaid
classDiagram
  direction LR
  class ChannelAdapter {
    <<interface>>
    +id
    +capabilities ChannelCapabilities
    +start(sink InboundSink)
    +send(target, message) DeliveryReceipt
    +stop()
  }
  class BaseChannelAdapter {
    <<abstract>>
    #renderer MessageRenderer
  }
  class TelegramChannelAdapter
  class WebChannelAdapter
  class WebhookChannelAdapter
  class MessageRenderer {
    <<interface>>
    +render(outbound, capabilities)
  }
  class ChannelCapabilities {
    +markdown
    +buttons
    +files
    +editMessages
    +voice
  }
  class ChannelRegistry {
    +get(id) ChannelAdapter
  }
  class ChannelGateway {
    +onInbound(message)
    +deliver(target, outbound)
  }
  class InboundSink {
    <<interface>>
    +accept(InboundMessage)
  }
  class VoiceNoteHandler
  class CodeGuard

  ChannelAdapter <|.. BaseChannelAdapter
  BaseChannelAdapter <|-- TelegramChannelAdapter
  BaseChannelAdapter <|-- WebChannelAdapter
  BaseChannelAdapter <|-- WebhookChannelAdapter
  BaseChannelAdapter --> MessageRenderer
  ChannelAdapter --> ChannelCapabilities
  ChannelRegistry o-- ChannelAdapter
  ChannelGateway --> ChannelRegistry
  InboundSink <|.. ChannelGateway
  ChannelGateway --> ThreadService
  ChannelGateway --> TaskRouter
  ChannelGateway --> JobQueue
  ChannelGateway --> VoiceNoteHandler
  ChannelGateway --> CodeGuard
```

`TelegramChannelAdapter` and `WebChannelAdapter` are *(named here)*; the docs describe them but give no class
names.

## 7. Trust, approvals and secrets

[F11](features/F11-trust-and-approvals.md), [F12](features/F12-secrets-vault.md). Facades over small,
single-purpose classes.

```mermaid
classDiagram
  direction LR
  class TrustService {
    <<facade>>
    +decide(action, check) Decision
  }
  class AuthoritySource {
    <<interface>>
    +forTurn(check) Authority
  }
  class SessionAuthority
  class AuthorityResolver {
    +resolve(sources) Authority
  }
  class PolicyEngine {
    +decide(action, rules) Decision
  }
  class TrustJudge {
    +judge(action, authority) Decision
  }
  class QuoteVerifier {
    +verify(quote, authority) bool
  }
  class TypedApprovalReader {
    +read(text, approval) Answer
  }
  class ApprovalService {
    +request(action, signal) Approval
    +resolve(id, answer)
    +finish(id, ok)
  }
  class UntrustedContent {
    +wrap(source, text) string
  }
  class Decision {
    <<union>>
    allow
    ask
    deny
  }
  class SecretStore {
    <<interface>>
  }
  class PostgresSecretStore
  class SecretBroker {
    +use(consumer, host, placement) SecretValue
  }
  class PlaceholderIssuer {
    +issueFor(run, bindings) Placeholder[]
    +resolve(run, host, placeholder) SecretValue
    +revoke(run)
  }
  class Redactor {
    +redactText(text)
    +redactImage(image)
  }
  class SecureFormService
  class SecretUseLog
  class EgressProxy {
    separate container
  }

  TrustService --> AuthoritySource
  AuthoritySource <|.. SessionAuthority
  SessionAuthority --> AuthorityResolver
  TrustService --> PolicyEngine
  TrustService --> TrustJudge
  TrustService --> ApprovalService
  TrustService ..> Decision
  TrustService --> QuoteVerifier
  TrustJudge --> ModelRouter : purpose trust
  TypedApprovalReader --> ModelRouter : purpose trust
  ApprovalService --> ActionRequest
  SecretStore <|.. PostgresSecretStore
  SecretBroker --> SecretStore
  SecretBroker --> SecretUseLog
  PlaceholderIssuer --> SecretBroker
  EgressProxy ..> PlaceholderIssuer : over HTTP
  Redactor --> SecretStore : active values
  SecureFormService --> SecretStore
```

`PostgresSecretStore` and `EgressProxy` are *(named here)*. The egress proxy is its own service, not a class in
`core`; it is shown to make the dependency visible.

## 8. The agent's computers

[F08](features/F08-workspace-sandbox.md), [F09](features/F09-browser.md), [F10](features/F10-desktop.md). Three ports so
each environment can move to a VM or a cloud sandbox without touching the runtime.

```mermaid
classDiagram
  direction LR
  class WorkspaceBackend {
    <<interface>>
    +exec(request, signal) ExecEvent[]
    +files() WorkspaceFiles
    +health() HealthStatus
  }
  class DockerWorkspaceBackend
  class RemoteVmWorkspaceBackend {
    later
  }
  class BrowserBackend {
    <<interface>>
    +open(sessionId, opts) BrowserSession
  }
  class BrowserSession {
    <<interface>>
    +snapshot() PageSnapshot
    +click(ref)
    +type(ref, text)
    +signIn(login)
  }
  class CdpBrowserBackend {
    Playwright connectOverCDP
  }
  class ComputerBackend {
    <<interface>>
    +state() ComputerState
    +screenshot() Image
    +act(action, signal) ActionResult
    +liveView() LiveViewTicket
    +setControl(mode)
  }
  class DockerDesktopBackend
  class E2BDesktopBackend {
    later
  }
  class AccessibilityReader {
    <<interface>>
    +tree(window) A11ySnapshot
    +act(snapshot, ref, action)
  }
  class AtSpiReader {
    Python helper via daemon
  }

  WorkspaceBackend <|.. DockerWorkspaceBackend
  WorkspaceBackend <|.. RemoteVmWorkspaceBackend
  BrowserBackend <|.. CdpBrowserBackend
  BrowserBackend ..> BrowserSession
  CdpBrowserBackend --> SecretBroker : sign-in fill
  ComputerBackend <|.. DockerDesktopBackend
  ComputerBackend <|.. E2BDesktopBackend
  DockerDesktopBackend --> AccessibilityReader
  AccessibilityReader <|.. AtSpiReader
```

`CdpBrowserBackend`, `AccessibilityReader` and `AtSpiReader` are *(named here)*. Inside the containers, the
workspace and desktop **daemons** are separate small programs that these adapters call over HTTP.

## 9. Integrations

[F18](features/F18-integrations-mcp.md).

```mermaid
classDiagram
  direction LR
  class AppConnector {
    <<interface>>
    +app
    +tools() BaseTool[]
    +changeSignal() ChangeSignal
    +readRecords(cursor) RecordPage
  }
  class MailConnector
  class CalendarConnector
  class EmailBackend {
    <<interface>>
    +search(query, page)
    +fetch(id, parts)
    +saveDraft(draft)
    +send(draft) SendReceipt
    +watch(signal) MailboxChange[]
  }
  class ImapSmtpBackend {
    imapflow and nodemailer
  }
  class GmailApiBackend {
    later
  }
  class HimalayaBackend {
    optional
  }
  class MailAccountRepository
  class MailSyncService
  class MailRenderer
  class AccountAccessFilter
  class DraftService
  class MailSender
  class McpServerRegistry
  class McpConnection
  class McpToolAdapter

  AppConnector <|.. MailConnector
  AppConnector <|.. CalendarConnector
  MailConnector --> MailAccountRepository
  MailConnector --> MailSyncService
  MailConnector --> MailRenderer
  MailConnector --> DraftService
  MailConnector --> MailSender
  MailSyncService --> AccountAccessFilter
  MailSyncService --> EmailBackend
  MailSender --> EmailBackend
  MailSender --> SecretBroker
  EmailBackend <|.. ImapSmtpBackend
  EmailBackend <|.. GmailApiBackend
  EmailBackend <|.. HimalayaBackend
  McpServerRegistry o-- McpConnection
  McpConnection ..> McpToolAdapter
```

The mail renderer was first called `MessageRenderer`, which clashed with the channel `MessageRenderer` in F06.
F18 now uses `MailRenderer` too.
`CalendarConnector` is *(named here)*.

## 10. Memory and skills

[F13](features/F13-long-term-memory.md), [F14](features/F14-skills.md), [F19](features/F19-learned-skills.md).

```mermaid
classDiagram
  direction LR
  class MemoryService {
    <<facade>>
    +learn(turn)
    +find(query)
    +forget(noteId)
  }
  class MemoryWriter
  class ProvenanceVerifier
  class MemoryRecall {
    <<interface>>
    +recall(query) Note[]
  }
  class KeywordRecall
  class VectorRecall
  class FusedRecall
  class RelevanceSelector
  class HistorySearch
  class MemoryMaintenance
  class MemoryMarkdownView
  class MemoryRepository
  class SkillSource {
    <<interface>>
    +list() SkillMeta[]
    +read(name) Skill
  }
  class BuiltInSkillSource
  class UserSkillSource
  class LearnedSkillSource
  class SkillLibrary {
    +index() SkillMeta[]
    +load(name) Skill
  }
  class SkillAuthor
  class SkillReviewer
  class SkillReviewQueue

  MemoryService --> MemoryWriter
  MemoryService --> MemoryRecall
  MemoryService --> MemoryRepository
  MemoryWriter --> ProvenanceVerifier
  MemoryWriter --> ModelRouter
  MemoryRecall <|.. KeywordRecall
  MemoryRecall <|.. VectorRecall
  MemoryRecall <|.. FusedRecall
  FusedRecall o-- MemoryRecall : rank fusion
  RelevanceSelector --> MemoryRecall
  MemoryMaintenance --> MemoryRepository
  MemoryMarkdownView --> MemoryRepository
  SkillSource <|.. BuiltInSkillSource
  SkillSource <|.. UserSkillSource
  SkillSource <|.. LearnedSkillSource
  SkillLibrary o-- SkillSource
  SkillAuthor --> Redactor
  SkillAuthor --> SkillReviewQueue
  SkillReviewer --> SkillReviewQueue
  LearnedSkillSource --> SkillReviewQueue : approved only
```

`FusedRecall` is *(named here)* for the "combined by rank fusion" step in F13.

## 11. Autonomy: tasks, schedules, proactivity

[F15](features/F15-tasks-and-subagents.md), [F16](features/F16-scheduler-and-routines.md),
[F17](features/F17-proactivity.md), [F24](features/F24-agent-profiles.md).

```mermaid
classDiagram
  direction LR
  class TaskService {
    +start(spec) Task
    +update(id, patch)
    +finish(id, result)
    +stop(id)
  }
  class TaskRouter {
    +route(inbound) Session
  }
  class DelegationService {
    +runHelpers(specs, budget)
  }
  class StallDetector
  class Scheduler {
    +tick()
  }
  class RoutineRunner
  class WatchRunner
  class WebhookReceiver
  class QuietRunPolicy
  class CostProjector
  class SignalCollector
  class SourceDiffer
  class BatchClassifier
  class Observer
  class MatterRepository
  class DeliveryGate
  class DailyBrief
  class ProfileRepository
  class ProfileResolver
  class ProfileSelector

  TaskService --> TaskRepository
  TaskService --> TurnScheduler
  TaskRouter --> TaskService
  DelegationService --> TurnRunner
  DelegationService --> StallDetector
  Scheduler --> RoutineRunner
  Scheduler --> WatchRunner
  RoutineRunner --> TurnScheduler
  RoutineRunner --> QuietRunPolicy
  WebhookReceiver --> TurnScheduler
  SignalCollector --> AppConnector
  SignalCollector --> SourceDiffer
  SourceDiffer --> BatchClassifier
  BatchClassifier --> Observer : non-routine only
  Observer --> MatterRepository
  Observer --> DeliveryGate
  DeliveryGate --> ChannelGateway
  DailyBrief --> MatterRepository
  ProfileResolver --> ProfileRepository
  ProfileSelector --> ProfileRepository
  TurnRunner --> ProfileResolver
```

## 12. Self-evolution

[F20](features/F20-tool-forge.md), [F21](features/F21-self-modification.md).

```mermaid
classDiagram
  direction LR
  class ToolForge {
    <<facade>>
    +scaffold(spec)
    +test(name)
    +propose(name, reason) ToolProposal
  }
  class ToolManifestValidator
  class StaticChecks
  class ForgeTestRunner
  class ToolProposal {
    +manifest
    +diff
    +testResults
    +reason
  }
  class ForgedToolRegistry {
    +approve(proposal) ForgedTool
    +rollback(name, version)
  }
  class ForgedTool
  class ToolHealthMonitor
  class SelfChangeService {
    +proposeChange(branch, summary, reason)
  }
  class ProtectedPaths {
    +check(diff) bool
  }
  class SelftestClient {
    calls selftest container
  }

  ToolForge --> ToolManifestValidator
  ToolForge --> StaticChecks
  ToolForge --> ForgeTestRunner
  ToolForge ..> ToolProposal
  ForgeTestRunner --> WorkspaceBackend
  ToolProposal --> ApprovalService
  ForgedToolRegistry ..> ForgedTool
  ForgedToolRegistry --> ToolRegistry
  ForgedTool --> PlaceholderIssuer
  ToolHealthMonitor --> ForgedToolRegistry
  SelfChangeService --> ProtectedPaths
  SelfChangeService --> SelftestClient
  SelfChangeService --> ApprovalService
```

F21 is mostly a process (branches, a `selftest` container, canary deploys), so `SelfChangeService`,
`ProtectedPaths` and `SelftestClient` are *(named here)* as the small amount of code `core` needs for it.

## 13. Persistence and observability

[F02](features/F02-persistence.md), [F22](features/F22-observability-and-cost.md). Repository and Unit of Work over
Postgres, with in-memory adapters for tests.

```mermaid
classDiagram
  direction LR
  class UnitOfWork {
    <<interface>>
    +run(fn) result
  }
  class ThreadRepository {
    <<interface>>
  }
  class SessionRepository {
    <<interface>>
  }
  class TurnRepository {
    <<interface>>
    +insert(turn)
    +transition(id, from, to) bool
  }
  class MessageRepository {
    <<interface>>
    +append(message)
    +search(query)
  }
  class TaskRepository {
    <<interface>>
  }
  class JobQueue {
    <<interface>>
    +enqueue(name, payload, opts)
    +work(name, handler)
  }
  class PostgresDatabase
  class PostgresRepositories {
    Kysely
  }
  class InMemoryRepositories {
    tests
  }
  class PgBossJobQueue
  class InMemoryJobQueue {
    tests
  }
  class UsageLedger {
    +record(usage)
  }
  class BudgetService {
    +reserve(scope, estimate) Reservation
    +settle(reservation, actual)
  }
  class TurnEventLog {
    turn_events
  }
  class EvalHarness {
    +run(scenarios, model) Report
  }

  UnitOfWork <|.. PostgresDatabase
  ThreadRepository <|.. PostgresRepositories
  SessionRepository <|.. PostgresRepositories
  TurnRepository <|.. PostgresRepositories
  MessageRepository <|.. PostgresRepositories
  TaskRepository <|.. PostgresRepositories
  ThreadRepository <|.. InMemoryRepositories
  TurnRepository <|.. InMemoryRepositories
  PostgresRepositories --> PostgresDatabase
  JobQueue <|.. PgBossJobQueue
  JobQueue <|.. InMemoryJobQueue
  PgBossJobQueue --> PostgresDatabase
  BudgetService --> UsageLedger
  ReceiptMiddleware --> TurnEventLog
  EvalHarness --> TurnRunner
```

`TurnEventLog` and `EvalHarness` are *(named here)* for the `turn_events` writer and the `pnpm eval` runner in
F22.

## Design patterns at a glance

| Pattern | Where | Section |
|---------|-------|---------|
| Ports and adapters | Every `<<interface>>` and its implementations | all |
| Composition root | `createShitsuji` | 1 |
| Plugin / registry | `PluginManager`, `ToolRegistry`, `ChannelRegistry`, `ForgedToolRegistry` | 1, 5, 6, 12 |
| Observer | `EventBus` | 1 |
| State machine | `Turn`, `Task`, `Approval` | 2 |
| Command | `ActionRequest` | 2, 7 |
| Strategy | `ModelProvider`, `MemoryRecall`, `EmailBackend`, `SearchProvider` | 3, 9, 10 |
| Decorator | `Metered` / `Retrying` / `RedactingModelProvider` | 3 |
| Template Method | `TurnRunner`, `BaseTool`, `BaseChannelAdapter` | 4, 5, 6 |
| Composite | `ContextBuilder` + `ContextInjectable`s, `FusedRecall` | 4, 10 |
| Chain of Responsibility | `ToolPipeline` + `ToolMiddleware`s | 5 |
| Adapter | `McpToolAdapter`, channel adapters | 5, 6, 9 |
| Facade | `Shitsuji`, `TrustService`, `MemoryService`, `ToolForge` | 1, 7, 10, 12 |
| Repository / Unit of Work | Section 13 | 13 |
