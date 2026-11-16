import type { OutboundMessage, OutboundPart } from '../../ports/ChannelAdapter.js';

/** Telegram's limit is 4096 characters; stay well under it so rendered HTML also fits. */
const DEFAULT_MAX_MARKDOWN = 3800;

export interface RenderedTelegram {
  /** One HTML chunk per message to send, in order. */
  chunks: string[];
  /** Parts the channel could not show as intended, already degraded to text. */
  degraded: OutboundPart['kind'][];
}

/**
 * Turns an OutboundMessage into Telegram HTML (F06, S32): Markdown from the model becomes the tags
 * Telegram allows, everything is escaped, and long replies are split at paragraph breaks. Splitting
 * happens on the Markdown *before* rendering, so a chunk never ends inside an HTML tag or a code fence.
 */
export class TelegramRenderer {
  constructor(private readonly maxMarkdown = DEFAULT_MAX_MARKDOWN) {}

  render(message: OutboundMessage): RenderedTelegram {
    const degraded: OutboundPart['kind'][] = [];
    const markdown = message.parts
      .map((part) => this.markdownOf(part, degraded))
      .filter(Boolean)
      .join('\n\n');
    return {
      chunks: splitMarkdown(markdown, this.maxMarkdown).map(toTelegramHtml).filter(Boolean),
      degraded,
    };
  }

  private markdownOf(part: OutboundPart, degraded: OutboundPart['kind'][]): string {
    switch (part.kind) {
      case 'text':
        return part.markdown;
      case 'link':
        return `[${part.label}](${part.url})`;
      case 'choices': {
        degraded.push('choices');
        const options = part.options.map((option, i) => `${i + 1}. ${option.label}`).join('\n');
        return `${part.multi ? 'Choose one or more' : 'Choose one'}:\n${options}`;
      }
      case 'approval':
        degraded.push('approval');
        return `${part.summary}\n[Approval needed: ${part.actionLabel}]`;
      case 'file':
        degraded.push('file');
        return `[file: ${part.caption ?? part.fileRef.name}]`;
      case 'image':
        degraded.push('image');
        return `[image: ${part.fileRef.name}]`;
    }
  }
}

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * A deliberately small Markdown subset: fenced and inline code, bold, italic, links and headings.
 * Anything else stays as written. Telegram has no tables, so they remain plain lines.
 */
export function toTelegramHtml(markdown: string): string {
  const blocks = markdown.split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) return `<pre>${escapeHtml(block.trim())}</pre>`;
      return inlineToHtml(block);
    })
    .filter((block) => block.trim().length > 0)
    .join('');
}

function inlineToHtml(text: string): string {
  const codes: string[] = [];
  const placeholder = '\uE000';
  const withoutCode = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${placeholder}CODE${codes.length - 1}${placeholder}`;
  });
  let html = escapeHtml(withoutCode);
  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, url: string) => `<a href="${url.replaceAll('"', '&quot;')}">${label}</a>`,
  );
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  return html.replace(/\uE000CODE(\d+)\uE000/g, (_, index: string) => codes[Number(index)] ?? '');
}

/** Splits Markdown at paragraph breaks, then lines, then hard, so no chunk exceeds `max`. */
export function splitMarkdown(markdown: string, max: number): string[] {
  const chunks: string[] = [];
  const push = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = chunks.at(-1);
    if (last && last.length + 2 + trimmed.length <= max)
      chunks[chunks.length - 1] = `${last}\n\n${trimmed}`;
    else chunks.push(trimmed);
  };

  for (const paragraph of markdown.split(/\n{2,}/)) {
    if (paragraph.length <= max) {
      push(paragraph);
      continue;
    }
    let current = '';
    for (const line of paragraph.split('\n')) {
      for (const piece of hardSplit(line, max)) {
        if (current && current.length + 1 + piece.length <= max) {
          current += `\n${piece}`;
        } else {
          if (current) push(current);
          current = piece;
        }
      }
    }
    if (current) push(current);
  }
  return chunks;
}

function hardSplit(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}
