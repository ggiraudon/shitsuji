import type { SessionId, TurnId } from '../domain/model/ids.js';

/** A channel's id, e.g. "webhook", "telegram", "web". */
export type ChannelId = string;

/** What a channel can show, so a renderer can degrade what it cannot (F06). */
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
  /** The message being answered, when the channel can thread. */
  replyTo?: MessageRef;
}

export interface MessageRef {
  channel: ChannelId;
  chatId: string;
  messageId?: string;
}

export interface FileRef {
  name: string;
  /** A path in the handoff folder, once files are stored (F08, T2). */
  path?: string;
  mediaType?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
}

/** One piece of an outbound message. A renderer turns these into what the channel can show. */
export type OutboundPart =
  | { kind: 'text'; markdown: string }
  | { kind: 'file'; fileRef: FileRef; caption?: string }
  | { kind: 'image'; fileRef: FileRef }
  | { kind: 'choices'; questionId: string; options: ChoiceOption[]; multi?: boolean }
  | { kind: 'approval'; approvalId: string; summary: string; actionLabel: string }
  | { kind: 'link'; url: string; label: string };

export type OutboundIntent = 'update' | 'final' | 'question' | 'nudge';

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

/** Renders an OutboundMessage the way one channel can show it (F06). */
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

/** A message arriving from a channel, before the gateway decides what it means (F06, S31). */
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

/** What the runtime did with an inbound message. */
export type InboundResult =
  | { kind: 'turn'; sessionId: SessionId; turnId: TurnId; steered: boolean }
  /** The gateway answered itself (pairing, a command, an approval): no turn ran. */
  | {
      kind: 'replied';
      reason: 'paired' | 'command' | 'approved' | 'declined' | 'approval-ambiguous';
    }
  /** Nothing happened: an unpaired chat, or a message with no text. */
  | { kind: 'ignored'; reason: string };

/** The one way an adapter hands a message to the core. */
/** The chat an adapter may ask about before it stores a file (F06, #44). */
export interface InboundChat {
  channel: ChannelId;
  chatId: string;
}

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

/** Template for adapters: running state and the sink; subclasses implement deliver(). */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly id: ChannelId;
  abstract readonly capabilities: ChannelCapabilities;
  readonly requiresPairing?: boolean = false;
  protected sink?: InboundSink;
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

  isRunning(): boolean {
    return this.running;
  }
}
