import type {
  ChannelCapabilities,
  MessageRenderer,
  OutboundMessage,
  OutboundPart,
  RenderedMessage,
} from '../../ports/ChannelAdapter.js';

/**
 * Turns an OutboundMessage into one block of text, for channels without buttons, files or cards
 * (the webhook now; more later). It reports which parts it had to degrade, so a caller can log or
 * choose a better adapter (F06).
 */
export class PlainTextRenderer implements MessageRenderer {
  render(message: OutboundMessage, capabilities: ChannelCapabilities): RenderedMessage {
    const degraded: OutboundPart['kind'][] = [];
    const blocks: string[] = [];
    for (const part of message.parts) {
      switch (part.kind) {
        case 'text':
          blocks.push(part.markdown);
          break;
        case 'link':
          if (capabilities.markdown === 'full') {
            blocks.push(`[${part.label}](${part.url})`);
          } else {
            blocks.push(`${part.label}: ${part.url}`);
            degraded.push('link');
          }
          break;
        case 'choices': {
          const options = part.options.map((option, i) => `${i + 1}. ${option.label}`).join('\n');
          blocks.push(`${part.multi ? 'Choose one or more' : 'Choose one'}:\n${options}`);
          degraded.push('choices');
          break;
        }
        case 'approval':
          blocks.push(`${part.summary}\n[Approval needed: ${part.actionLabel}]`);
          degraded.push('approval');
          break;
        case 'file':
          blocks.push(`[file: ${part.caption ?? part.fileRef.name}]`);
          degraded.push('file');
          break;
        case 'image':
          blocks.push(`[image: ${part.fileRef.name}]`);
          degraded.push('image');
          break;
      }
    }
    const joined = blocks.filter(Boolean).join('\n\n');
    const text =
      joined.length <= capabilities.maxMessageLength
        ? joined
        : `${joined.slice(0, Math.max(0, capabilities.maxMessageLength - 20))}\n… (truncated)`;
    return { text, degraded };
  }
}
