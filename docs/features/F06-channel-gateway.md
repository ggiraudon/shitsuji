# F06 — Channel gateway and Telegram

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 1 Reach and control | 6 | M | F04 | F07, F11, F23 |

## What it is

A clean separation between **how a message travels** (Telegram, web, CLI, webhook, later WhatsApp, Slack,
Discord, email) and **what Shitsuji does with it**. A `ChannelGateway` turns inbound messages into turns on the
owner's thread and delivers replies, updates, files and approval prompts in the best form each channel
supports. The first new adapter is **Telegram**.

## Where Shitsuji is today

Until S30, `Channel` had `start`, `stop`, `send(destination, text)` and `onMessage`, replies were plain strings,
and the webhook channel's `send` only printed ([bug 5](../00-current-state.md#bugs-and-gaps-found)). S30
replaced that with the rich `ChannelAdapter` port and a `MessageRenderer`: the webhook answers its POST with
the turn's reply, the API hands its messages over as `InboundMessage` (its replies still travel on
`/api/events`), and plugins fill a `ChannelRegistry`.

Since S31 the `ChannelGateway` resolves each chat through a binding, pairs a new chat with `/start <code>`
(the code comes from the TUI's `/pair`), ignores unpaired chats on channels that declare `requiresPairing`,
answers `/stop`, `/status` and `/new`, and hands everything else to the agent with a reply channel.
S32 adds the Telegram adapter itself: grammY long polling, Markdown as Telegram HTML, long replies split
at paragraph breaks, one "Working…" message removed when the reply arrives, and pairing through the same
gateway. S33 adds files: a photo or document the owner sends is saved in `<dataDir>/handoff` and the turn is
told its path, a file the agent attaches comes back as a Telegram document, and a voice note gets
"I can't listen to voice notes yet." S37 adds approval cards with buttons; the live phone check is in [10-live-checks.md](../10-live-checks.md).

## Inspiration

- **nod:** one thread shared by web, Telegram and WhatsApp; each turn records its reply channel, so a Telegram
  message is answered on Telegram; on Telegram a task's progress updates in place in one message; `/tasks`,
  `/status`, `/stop` commands; lists instead of tables on chat apps; one-time codes are caught before they
  reach the model.
- **openbot / OpenMausBot:** channel apps as separate adapters; notifications decided once for all clients.

## Design

### Port

```ts
export interface ChannelAdapter {
  readonly id: ChannelId;                       // "telegram", "web", "cli", "webhook"
  readonly capabilities: ChannelCapabilities;
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  deliver(target: ChannelTarget, msg: OutboundMessage): Promise<DeliveryReceipt>;
  edit?(receipt: DeliveryReceipt, msg: OutboundMessage): Promise<void>;   // in-place progress
  typing?(target: ChannelTarget): Promise<void>;
}

interface ChannelCapabilities {
  markdown: 'full' | 'basic' | 'none';
  buttons: boolean;              // inline keyboards / cards
  files: boolean;
  images: boolean;
  voice: boolean;
  edits: boolean;
  maxMessageLength: number;
}
```

### Message model

```ts
type OutboundMessage = {
  parts: Array<
    | { kind: 'text'; markdown: string }
    | { kind: 'file'; fileRef: FileRef; caption?: string }
    | { kind: 'image'; fileRef: FileRef }
    | { kind: 'choices'; questionId: string; options: ChoiceOption[]; multi?: boolean }
    | { kind: 'approval'; approvalId: string; summary: string; actionLabel: string }
    | { kind: 'link'; url: string; label: string }          // e.g. "Take control" of the desktop
  >;
  replyTo?: MessageRef;
  intent: 'update' | 'final' | 'question' | 'nudge';
};
```

A `MessageRenderer` per adapter **degrades** what the channel cannot show: tables become lists on Telegram,
choices become numbered options on the CLI, an approval becomes a card with two buttons on web and Telegram.

### Gateway

```ts
class ChannelGateway implements InboundSink {
  async receive(msg: InboundMessage): Promise<void> {
    const owner = await this.bindings.resolveOwner(msg.channel, msg.externalChatId);   // unknown → refuse
    if (await this.codeGuard.intercepts(owner, msg)) return;          // one-time codes, see F12
    if (this.commands.matches(msg)) return this.commands.run(owner, msg);   // /stop, /tasks, /status
    if (msg.callback) return this.callbacks.handle(owner, msg.callback);    // button presses
    await this.uow.run(async (tx) => {
      const stored = await this.messages.append(toStored(owner, msg), tx);
      const session = await this.router.sessionFor(owner, msg, tx);    // reply to a task → that task's session
      if (this.runtime.isRunning(session)) this.steering.push(session, stored);
      else await this.turns.enqueue({ session, source: 'user', replyChannel: msg.channel }, tx);
    });
  }
}
```

- **Binding and pairing.** A new Telegram chat must be paired once: the web UI shows a code, you send
  `/start <code>` to the bot. Messages from unpaired chats are ignored. This is the access control for chat
  channels. Only **private** chats are accepted: a group or channel message is dropped by the Telegram
  adapter, because pairing a chat would otherwise let every member act as the owner (#38). `/start` in an
  already-paired chat answers "Already paired." without a model call, and an unpaired chat is logged once
  per minute with a count of what it sent (#39).
- **Reply routing.** A reply to a task's message goes to that task's session; anything else goes to the main
  chat session ([F15](F15-tasks-and-subagents.md)). The webhook keys each waiting POST by the turn it
  started or was steered into, so a steered message gets that turn's reply and not the next caller's
  (#35).
- **Attachments** are stored in `<dataDir>/handoff` (decision T2) and the turn is told the absolute paths.
  The file tools may read that folder but never write it; until F08 the workspace container can take it over.
  An adapter asks the gateway (`accepts`) before downloading, so an unpaired chat stores nothing and gets
  no voice-note answer (#44).
- **Files back.** A tool result can carry `files` (the `workspace.send` tool does); the turn publishes them on
  `turn.status` and the reply reaches the channel as file parts, which Telegram sends as documents (the tool
  refuses files above 48 MB, keeping under Telegram's 50 MB bot limit).

S31 builds the first slice of this: `ChannelGateway`, channel bindings (with a per-chat session so `/new`
works), `PairingService` (short-lived, single-use codes issued from `POST /api/pair` and shown by the TUI's
`/pair`), and the `/stop`, `/status` and `/new` commands. A channel that declares `requiresPairing` starts no
turn until its chat is paired; the webhook and the API stay open because they are local transports. Callback
task routing waits for [F15](F15-tasks-and-subagents.md); buttons and attachments are in (S33, S37).

### Telegram adapter

- Library: grammY. Long polling by default (no public URL needed); webhook mode when a proxy and domain exist.
- Markdown → Telegram MarkdownV2 or HTML, with escaping; long replies split at paragraph breaks. Inline
  rules never cross (a link's label is rendered inside the anchor), and if Telegram still refuses a
  chunk's HTML, the same chunk is resent as plain text, so odd Markdown never loses a reply (#41).
- Inline keyboards for approvals and choices; callback data carries only an opaque ID.
  *(S37: an approval card's buttons call back `y:<id>` / `n:<id>`, so the data names only the decision
  and the approval, never the action; a typed yes or no is read on its own by the trust model.)*
- Progress: one "working…" message edited in place, removed when the turn ends. *(#42: a Working message that arrives after the reply is deleted too, and
  `bot.catch` logs a handler failure instead of letting grammY stop polling.)*
- Files: documents, photos and voice notes are downloaded into the handoff folder; sent files go back as
  documents. Voice notes are stored for [F23](F23-voice.md), which answers that it cannot listen yet.
- Commands: `/stop`, `/tasks`, `/status`, `/new` (reset thread, with confirmation). A turn the owner
  stopped answers once, "Stopped."; the cancelled turn is not also reported as an error (#68).

S32 builds the adapter: grammY long polling behind a narrow transport, the bot token from
`channels.telegram.token` (a `Secret`, from `SHITSUJI_TELEGRAM_TOKEN`), Markdown to Telegram HTML with
escaping and paragraph splitting, and one "Working…" message removed when the reply is delivered.

S33 adds the files: the transport maps document, photo and voice updates, downloads them with `getFile`,
and the adapter stores them with a safe, unique name in `<dataDir>/handoff` before telling the gateway where
they are; a download failure loses the file, not the message. Outbound, the adapter reads each file part and
sends it with `sendDocument`, keeping the text when a file cannot be read. Approval keyboards arrive with
S37; speech-to-text for F23.

## Changes to existing code

| File | Change |
|------|--------|
| `channels/base.ts` | → `ports/ChannelAdapter.ts` (richer); `BaseChannel` becomes `BaseChannelAdapter` (template method for start/stop) |
| `channels/index.ts` | `ChannelManager` → `ChannelRegistry` filled by plugins (S30) |
| `channels/CLIChannel.ts` | Removed with decision Q4; the TUI is the terminal interface |
| `channels/WebhookChannel.ts` | `adapters/channels/WebhookChannelAdapter.ts`: answers its POST with the reply now. Because the caller reads the answer, a POST needs the owner key (`Authorization: Bearer`, 401 without it) and the server listens on `127.0.0.1` unless `channels.webhook.host` is set ([#34](https://github.com/ggiraudon/shitsuji/issues/34)). Signed requests from other services and a real trigger for [F16](F16-scheduler-and-routines.md) come later |
| `adapters/files/HandoffStore.ts` | New (S33): saves channel attachments in `<dataDir>/handoff` with a safe, unique name (T2) |
| `adapters/tools/workspace.ts` | New `workspace.send` (S33, effect `external` since S41); `resolveRead` lets the read and list tools reach the handoff folder, and `WorkspaceRoot` gained read-only extra roots |
| `ports/Tool.ts` | `OutboundFile` and `outboundFiles()` (S33): a tool result may name files for the reply |

## Acceptance criteria

- Pair Telegram from the web UI; chat; approve an action with a button; get a file back.
  *(S33: a file the agent attaches comes back as a document; S37: an approval card has Approve/Decline
  buttons and a typed yes/no. Pairing is through the TUI (`/pair` + `/start <code>`) until the web UI,
  F07; the live phone check is in [10-live-checks.md](../10-live-checks.md).)*
- A photo and a document the owner sends reach the agent in `<dataDir>/handoff`; a voice note is kept and answered
  "I can't listen to voice notes yet." *(S33)*
- A message from an unpaired Telegram chat starts no turn.
- Adding a new channel needs one adapter class and a plugin manifest, no change to the core.

## Risks and open questions

- Telegram bots cannot start a conversation with you; the first message must come from you. Pairing covers it.
- Telegram stores messages on its servers. Note it in privacy docs; never send secrets or private links there
  ([F12](F12-secrets-vault.md)).

