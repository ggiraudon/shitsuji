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
`/api/events`), and plugins fill a `ChannelRegistry`. The gateway, pairing and Telegram follow in S31–S33.

Since S31 the `ChannelGateway` resolves each chat through a binding, pairs a new chat with `/start <code>`
(the code comes from the TUI's `/pair`), ignores unpaired chats on channels that declare `requiresPairing`,
answers `/stop`, `/status` and `/new`, and hands everything else to the agent with a reply channel.
Telegram itself follows in S32.

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
  channels.
- **Reply routing.** A reply to a task's message goes to that task's session; anything else goes to the main
  chat session ([F15](F15-tasks-and-subagents.md)).
- **Attachments** are stored as files in the `handoff` volume so the workspace can process them.

S31 builds the first slice of this: `ChannelGateway`, channel bindings (with a per-chat session so `/new`
works), `PairingService` (short-lived, single-use codes issued from `POST /api/pair` and shown by the TUI's
`/pair`), and the `/stop`, `/status` and `/new` commands. A channel that declares `requiresPairing` starts no
turn until its chat is paired; the webhook and the API stay open because they are local transports. Callback
buttons, task routing and attachments wait for F11 and S33.

### Telegram adapter

- Library: grammY. Long polling by default (no public URL needed); webhook mode when a proxy and domain exist.
- Markdown → Telegram MarkdownV2 or HTML, with escaping; long replies split at paragraph breaks.
- Inline keyboards for approvals and choices; callback data carries only an opaque ID.
- Progress: one "working…" message edited in place, removed when the turn ends.
- Voice notes → stored file → speech-to-text when [F23](F23-voice.md) arrives.
- Commands: `/stop`, `/tasks`, `/status`, `/new` (reset thread, with confirmation).

## Changes to existing code

| File | Change |
|------|--------|
| `channels/base.ts` | → `ports/ChannelAdapter.ts` (richer); `BaseChannel` becomes `BaseChannelAdapter` (template method for start/stop) |
| `channels/index.ts` | `ChannelManager` → `ChannelRegistry` filled by plugins (S30) |
| `channels/CLIChannel.ts` | Removed with decision Q4; the TUI is the terminal interface |
| `channels/WebhookChannel.ts` | `adapters/channels/WebhookChannelAdapter.ts`: answers its POST with the reply now; signed requests and a real trigger for [F16](F16-scheduler-and-routines.md) come later |

## Acceptance criteria

- Pair Telegram from the web UI; chat; approve an action with a button; get a file back.
- A message from an unpaired Telegram chat starts no turn.
- Adding a new channel needs one adapter class and a plugin manifest, no change to the core.

## Risks and open questions

- Telegram bots cannot start a conversation with you; the first message must come from you. Pairing covers it.
- Telegram stores messages on its servers. Note it in privacy docs; never send secrets or private links there
  ([F12](F12-secrets-vault.md)).
