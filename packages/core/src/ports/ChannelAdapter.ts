import type { SessionId, TurnId } from '../domain/model/ids.js';

/** A channel's id, e.g. "webhook", "telegram", "web". It is also the prefix of a reply channel. */
export type ChannelId = string;

/**
 * What a channel can show, so a renderer can degrade what it cannot (F06). The adapter declares this
 * once at startup; `MessageRenderer` reads it instead of asking the transport.
 */
export interface ChannelCapabilities {
  markdown: 'full' | 'basic' | 'none';
  /** Inline keyboards or cards. */
  buttons: boolean;
  files: boolean;
  images: boolean;
  voice: boolean;
  /** Can replace an earlier message in place (progress updates). */
  edits: boolean;
  maxMessageLength: number;
}

/** Where an outbound message goes. */
export interface ChannelTarget {
  /** The channel's own conversation id: a chat, a webhook destination, a web session. */
  chatId: string;
  /** The turn this delivery answers, when the channel can route by it (the webhook, F06 #35). */
  turnId?: TurnId;
  /** The message being answered, when the channel can thread. */
  replyTo?: MessageRef;
}

/** A message on a channel, enough to reply to it or edit it later. */
export interface MessageRef {
  channel: ChannelId;
  chatId: string;
  messageId?: string;
}

/** A file to deliver. `path` is readable by the adapter itself, which uploads the bytes. */
export interface FileRef {
  name: string;
  /** Absolute path on the core machine (a staged file or a handoff-folder file, F08, S41). */
  path?: string;
  mediaType?: string;
}

/** One button of a `choices` part; `id` is what the channel sends back when it is pressed. */
export interface ChoiceOption {
  id: string;
  label: string;
}

/**
 * One piece of an outbound message. A renderer turns these into what the channel can show: text and
 * links as text, files and images as attachments, choices as buttons, an approval as its card. An
 * adapter that cannot show a kind degrades it to text and reports that in `RenderedMessage.degraded`.
 */
export type OutboundPart =
  | { kind: 'text'; markdown: string }
  | { kind: 'file'; fileRef: FileRef; caption?: string }
  | { kind: 'image'; fileRef: FileRef }
  | { kind: 'choices'; questionId: string; options: ChoiceOption[]; multi?: boolean }
  | { kind: 'approval'; approvalId: string; summary: string; actionLabel: string }
  | { kind: 'link'; url: string; label: string };

/**
 * Why a message is sent: `final` answers the turn, `question` asks the owner something (a card or a
 * check-in), `update` is meant to replace an earlier message while work runs, and `nudge` to open a
 * conversation proactively. The runtime sends only `final` and `question` today.
 */
export type OutboundIntent = 'update' | 'final' | 'question' | 'nudge';

/** Everything one outbound message is made of, with its intent. */
export interface OutboundMessage {
  parts: OutboundPart[];
  replyTo?: MessageRef;
  intent: OutboundIntent;
}

/** What a renderer produced for one channel. */
export interface RenderedMessage {
  text: string;
  /** Parts the channel could not show as intended, already degraded to text. */
  degraded: OutboundPart['kind'][];
}

/** Renders an OutboundMessage the way one channel can show it (F06). Pure: no I/O, no state. */
export interface MessageRenderer {
  render(message: OutboundMessage, capabilities: ChannelCapabilities): RenderedMessage;
}

/** What a channel did with an outbound message. */
export interface DeliveryReceipt {
  delivered: boolean;
  /** The channel's own id for what it delivered, for edits. */
  externalId?: string;
  /** Why it was not delivered (no waiting request, channel down…). */
  reason?: string;
}

/** A file the owner sent on a channel, stored where the agent can read it (decision T2). */
export interface InboundAttachment {
  name: string;
  /** Absolute path in the handoff folder. */
  path: string;
  mediaType?: string;
  size?: number;
}

/**
 * A message arriving from a channel, before the gateway decides what it means (F06, S31). The adapter
 * fills what its transport knows; `sessionId` and the callback payload are for channels that can route
 * precisely (the API and inline buttons). The gateway maps the chat to an owner thread and session.
 */
export interface InboundMessage {
  /** The adapter that received it: "webhook", "telegram", "api". */
  channel: ChannelId;
  /** The channel's conversation id. */
  chatId: string;
  text: string;
  /** The channel's own id for the message, for replies and edits. */
  externalId?: string;
  receivedAt: Date;
  /** Set when the sender picked a session (the API's TUI); chat channels leave it to the gateway. */
  sessionId?: SessionId;
  /** Files saved in the handoff folder; the gateway tells the turn where they are. */
  attachments?: InboundAttachment[];
  /** A press on a card's button; `data` is the channel's opaque payload (S37). */
  callback?: { id: string; data: string; messageId?: string };
  metadata?: Record<string, unknown>;
}

/**
 * What the runtime did with an inbound message: started or steered a turn, answered it itself (pairing,
 * a command, an approval), or ignored it. The webhook reports it back to its client; chat adapters mostly
 * log it, and the reply itself goes out through `deliver`.
 */
export type InboundResult =
  | { kind: 'turn'; sessionId: SessionId; turnId: TurnId; steered: boolean }
  /** The gateway answered itself (pairing, a command, an approval): no turn ran. */
  | {
      kind: 'replied';
      reason: 'paired' | 'command' | 'approved' | 'declined' | 'approval-ambiguous';
    }
  /** Nothing happened: an unpaired chat, or a message with no text. */
  | { kind: 'ignored'; reason: string };

/** The chat an adapter may ask about before it stores a file (F06, #44). */
export interface InboundChat {
  channel: ChannelId;
  chatId: string;
}

/**
 * The one way an adapter hands a message to the core: `ChannelGateway.receive` after a pairing check,
 * and it is what the adapter gets from `start`. It must not throw for a bad message; an unpaired or
 * empty one comes back as `ignored`.
 */
export interface InboundSink {
  receive(message: InboundMessage): Promise<InboundResult>;
  /**
   * True when this chat may start a turn. An adapter checks it before downloading an attachment or
   * answering a voice note, so an unpaired chat cannot fill the disk (F06, #44).
   */
  accepts?(chat: InboundChat): Promise<boolean>;
}

/**
 * A chat channel. The adapter owns transport and formatting; the core owns what a message means.
 * Adding a channel is one adapter class plus a plugin manifest (F06).
 *
 * Lifecycle: `start` once with the sink, `stop` once on shutdown or when the transport dies. The
 * adapter must not start turns itself: every inbound message goes through `sink.receive`, so pairing,
 * commands and approvals are decided in one place.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** True for chat apps that must be paired once before they can start turns (Telegram, F06). */
  readonly requiresPairing?: boolean;
  /** Starts the transport and hands inbound messages to the sink. */
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  deliver(target: ChannelTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
  /** Replaces an earlier delivery in place, when `capabilities.edits` is true. */
  edit?(receipt: DeliveryReceipt, message: OutboundMessage): Promise<void>;
  /** Shows a typing indicator, when the channel has one. */
  typing?(target: ChannelTarget): Promise<void>;
}

/**
 * Template for adapters: running state and the sink; subclasses implement deliver(). A subclass starts
 * and stops its own client around `super.start(sink)` and `super.stop()` (see `TelegramChannelAdapter`),
 * then feeds every inbound message to `sink.receive`. `deliver` may throw on a transport failure; the
 * caller (`Shitsuji.deliverTo`) logs it and does not retry.
 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly id: ChannelId;
  abstract readonly capabilities: ChannelCapabilities;
  readonly requiresPairing?: boolean = false;
  /** Set by `start`; subclasses call `this.sink?.receive(...)` for every inbound message. */
  protected sink?: InboundSink;
  /** True between `start` and `stop`; for subclasses that guard their own timers and handlers. */
  protected running = false;

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.sink = undefined;
  }

  abstract deliver(target: ChannelTarget, message: OutboundMessage): Promise<DeliveryReceipt>;

  /** Whether `start` has run and `stop` has not. */
  isRunning(): boolean {
    return this.running;
  }
}
