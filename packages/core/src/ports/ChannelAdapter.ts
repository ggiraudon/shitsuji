import type { SessionId, TurnId } from '../domain/model/ids.js';

/** A channel's id, e.g. "webhook", "telegram", "web". It is also the prefix of a reply channel. */
export type ChannelId = string;

/**
 * What a channel can show, so a renderer can degrade what it cannot (F06). The adapter declares this
 * once at startup; `MessageRenderer` reads it instead of asking the transport.
 */
export interface ChannelCapabilities {
  /** How much Markdown the channel renders: full HTML subset, basic emphasis, or plain text. */
  markdown: 'full' | 'basic' | 'none';
  /** Inline keyboards or cards. */
  buttons: boolean;
  /** Can attach documents. */
  files: boolean;
  /** Can show an image inline; otherwise the renderer sends it as a file. */
  images: boolean;
  /** Can send or receive voice notes; the core transcribes when it can. */
  voice: boolean;
  /** Can replace an earlier message in place (progress updates). */
  edits: boolean;
  /** The transport's hard limit per message; the renderer splits longer text. */
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
  /** The adapter that owns the message, e.g. `telegram`. */
  channel: ChannelId;
  /** The conversation it is in. */
  chatId: string;
  /** The channel's id for the message, when the channel numbers them. */
  messageId?: string;
}

/** A file to deliver. `path` is readable by the adapter itself, which uploads the bytes. */
export interface FileRef {
  /** The file name the owner sees, including its extension. */
  name: string;
  /** Absolute path on the core machine (a staged file or a handoff-folder file, F08, S41). */
  path?: string;
  /** MIME type, when known; channels that care use it to pick photo or document. */
  mediaType?: string;
}

/** One button of a `choices` part; `id` is what the channel sends back when it is pressed. */
export interface ChoiceOption {
  /** The value the channel returns with the press; the gateway maps it to an answer. */
  id: string;
  /** The text on the button. */
  label: string;
}

/**
 * One piece of an outbound message. A renderer turns these into what the channel can show: text and
 * links as text, files and images as attachments, choices as buttons, an approval as its card. An
 * adapter that cannot show a kind degrades it to text and reports that in `RenderedMessage.degraded`.
 */
export type OutboundPart =
  | {
      /** Markdown text to show. */
      kind: 'text';
      /** The body, in Markdown; the renderer degrades it to what the channel supports. */
      markdown: string;
    }
  | {
      /** A document to attach. */
      kind: 'file';
      /** The file to send; a missing path makes the adapter skip it. */
      fileRef: FileRef;
      /** Text to show with the file. */
      caption?: string;
    }
  | {
      /** An image to show inline, or as a file where the channel cannot. */
      kind: 'image';
      /** The image to send. */
      fileRef: FileRef;
    }
  | {
      /** A question with buttons, e.g. a multiple-choice prompt. */
      kind: 'choices';
      /** Identifies the question, so the answer can be matched to it. */
      questionId: string;
      /** The buttons, in display order. */
      options: ChoiceOption[];
      /** Whether more than one may be pressed; single choice otherwise. */
      multi?: boolean;
    }
  | {
      /** An approval card: what waits, and the button that answers it. */
      kind: 'approval';
      /** The card to approve or decline. */
      approvalId: string;
      /** One line describing the action. */
      summary: string;
      /** The label on the approve button. */
      actionLabel: string;
    }
  | {
      /** A link the channel should show as a link rather than Markdown. */
      kind: 'link';
      /** The target. */
      url: string;
      /** The text to click. */
      label: string;
    };

/**
 * Why a message is sent: `final` answers the turn, `question` asks the owner something (a card or a
 * check-in), `update` is meant to replace an earlier message while work runs, and `nudge` to open a
 * conversation proactively. The runtime sends only `final` and `question` today.
 */
export type OutboundIntent = 'update' | 'final' | 'question' | 'nudge';

/** Everything one outbound message is made of, with its intent. */
export interface OutboundMessage {
  /** The content, in order; text first is the convention. */
  parts: OutboundPart[];
  /** The message being answered, when the channel can thread. */
  replyTo?: MessageRef;
  /** Why it is sent; decides how the channel presents it. */
  intent: OutboundIntent;
}

/** What a renderer produced for one channel. */
export interface RenderedMessage {
  /** The body, already limited to the channel's length and format. */
  text: string;
  /** Parts the channel could not show as intended, already degraded to text. */
  degraded: OutboundPart['kind'][];
}

/** Renders an OutboundMessage the way one channel can show it (F06). Pure: no I/O, no state. */
export interface MessageRenderer {
  /** Turns parts into text for the given capabilities; never throws for a part it cannot show. */
  render(message: OutboundMessage, capabilities: ChannelCapabilities): RenderedMessage;
}

/** What a channel did with an outbound message. */
export interface DeliveryReceipt {
  /** False when the channel chose not to send it; the caller logs the reason and does not retry. */
  delivered: boolean;
  /** The channel's own id for what it delivered, for edits. */
  externalId?: string;
  /** Why it was not delivered (no waiting request, channel down…). */
  reason?: string;
}

/** A file the owner sent on a channel, stored where the agent can read it (decision T2). */
export interface InboundAttachment {
  /** The original file name, as the channel reported it. */
  name: string;
  /** Absolute path in the handoff folder. */
  path: string;
  /** MIME type, when the transport supplies it. */
  mediaType?: string;
  /** Size in bytes, when the transport supplies it; the tools apply their own limits too. */
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
  /** The message text; a message with no text is `ignored` by the gateway. */
  text: string;
  /** The channel's own id for the message, for replies and edits. */
  externalId?: string;
  /** When the adapter received it, from its own clock; the gateway stores it as `createdAt`. */
  receivedAt: Date;
  /** Set when the sender picked a session (the API's TUI); chat channels leave it to the gateway. */
  sessionId?: SessionId;
  /** Files saved in the handoff folder; the gateway tells the turn where they are. */
  attachments?: InboundAttachment[];
  /** A press on a card's button; `data` is the channel's opaque payload (S37). */
  callback?: {
    /** The channel's id for the press, when it has one. */
    id: string;
    /** The opaque payload the channel sends back, e.g. the approval id and the answer. */
    data: string;
    /** The message the button belonged to, for editing it after the press. */
    messageId?: string;
  };
  /** Whatever else the transport supplies, for adapters that need it; never used by the core. */
  metadata?: Record<string, unknown>;
}

/**
 * What the runtime did with an inbound message: started or steered a turn, answered it itself (pairing,
 * a command, an approval), or ignored it. The webhook reports it back to its client; chat adapters mostly
 * log it, and the reply itself goes out through `deliver`.
 */
export type InboundResult =
  | {
      /** A turn now answers the message. */
      kind: 'turn';
      /** The session the turn runs in. */
      sessionId: SessionId;
      /** The turn that will answer, new or already running. */
      turnId: TurnId;
      /** True when the message joined a running turn instead of queueing its own. */
      steered: boolean;
    }
  /** The gateway answered itself (pairing, a command, an approval): no turn ran. */
  | {
      /** The message was handled by the gateway. */
      kind: 'replied';
      /** What it answered: pairing, a command, or an approval decision. */
      reason: 'paired' | 'command' | 'approved' | 'declined' | 'approval-ambiguous';
    }
  /** Nothing happened: an unpaired chat, or a message with no text. */
  | {
      /** The message was dropped. */
      kind: 'ignored';
      /** Why, for the adapter's log: `unpaired`, `empty message`, … */
      reason: string;
    };

/** The chat an adapter may ask about before it stores a file (F06, #44). */
export interface InboundChat {
  /** The adapter the message came through. */
  channel: ChannelId;
  /** The conversation to check. */
  chatId: string;
}

/**
 * The one way an adapter hands a message to the core: `ChannelGateway.receive` after a pairing check,
 * and it is what the adapter gets from `start`. It must not throw for a bad message; an unpaired or
 * empty one comes back as `ignored`.
 */
export interface InboundSink {
  /** Stores the message and decides whether it starts, joins or is ignored; see {@link InboundResult}. */
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
  /** The adapter's id; it prefixes reply channels (`telegram:12345`). */
  readonly id: ChannelId;
  /** What the transport can show; a renderer degrades everything else. */
  readonly capabilities: ChannelCapabilities;
  /** True for chat apps that must be paired once before they can start turns (Telegram, F06). */
  readonly requiresPairing?: boolean;
  /** Starts the transport and hands inbound messages to the sink. */
  start(sink: InboundSink): Promise<void>;
  /** Stops the transport; the process calls it once, newest channel first. */
  stop(): Promise<void>;
  /** Sends one message; a transport failure may throw, and the caller does not retry. */
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
  /** The adapter's id; subclasses set it once. */
  abstract readonly id: ChannelId;
  /** What the transport can show; subclasses set it once. */
  abstract readonly capabilities: ChannelCapabilities;
  /** False by default; `true` for chat apps that pair once (Telegram). */
  readonly requiresPairing?: boolean = false;
  /** Set by `start`; subclasses call `this.sink?.receive(...)` for every inbound message. */
  protected sink?: InboundSink;
  /** True between `start` and `stop`; for subclasses that guard their own timers and handlers. */
  protected running = false;

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.running = true;
  }

  /** Drops the sink and marks the adapter stopped; a subclass stops its client around this. */
  async stop(): Promise<void> {
    this.running = false;
    this.sink = undefined;
  }

  /** Sends one message; subclasses implement it with their transport. */
  abstract deliver(target: ChannelTarget, message: OutboundMessage): Promise<DeliveryReceipt>;

  /** Whether `start` has run and `stop` has not. */
  isRunning(): boolean {
    return this.running;
  }
}
