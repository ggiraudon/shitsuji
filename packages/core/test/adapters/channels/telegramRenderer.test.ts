import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  splitMarkdown,
  TelegramRenderer,
  toTelegramHtml,
} from '../../../src/adapters/channels/TelegramRenderer.js';
import type { OutboundMessage } from '../../../src/ports/ChannelAdapter.js';

const text = (markdown: string): OutboundMessage => ({
  intent: 'final',
  parts: [{ kind: 'text', markdown }],
});

describe('Telegram HTML', () => {
  it('escapes HTML', () => {
    expect(escapeHtml('<b> & "x"')).toBe('&lt;b&gt; &amp; "x"');
  });

  it('renders bold, italic, inline code and links', () => {
    const html = toTelegramHtml(
      'Hi **you**, *please* read `1<2` and visit [the site](https://example.com/a?b=1&c=2).',
    );

    expect(html).toContain('<b>you</b>');
    expect(html).toContain('<i>please</i>');
    expect(html).toContain('<code>1&lt;2</code>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">the site</a>');
  });

  it('renders a fenced code block as pre and keeps it inside one tag', () => {
    const html = toTelegramHtml('Before\n```\nconst x = 1 < 2;\n```\nAfter');
    expect(html).toContain('<pre>const x = 1 &lt; 2;</pre>');
    expect(html).not.toContain('**');
  });

  it('leaves a non-http link as text', () => {
    const html = toTelegramHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).toContain('javascript:alert(1)');
  });
});

describe('TelegramRenderer', () => {
  it('degrades choices, approvals, files and images to text', () => {
    const message: OutboundMessage = {
      intent: 'final',
      parts: [
        { kind: 'text', markdown: 'Here:' },
        {
          kind: 'choices',
          questionId: 'q',
          options: [
            { id: 'a', label: 'Yes' },
            { id: 'b', label: 'No' },
          ],
        },
        { kind: 'approval', approvalId: 'a', summary: 'Send it?', actionLabel: 'Approve' },
        { kind: 'file', fileRef: { name: 'report.pdf' } },
        { kind: 'image', fileRef: { name: 'shot.png' } },
      ],
    };

    const rendered = new TelegramRenderer().render(message);

    expect(rendered.chunks.join('\n')).toContain('1. Yes');
    expect(rendered.chunks.join('\n')).toContain('Send it?');
    expect(rendered.chunks.join('\n')).toContain('[file: report.pdf]');
    expect(rendered.chunks.join('\n')).toContain('[image: shot.png]');
    expect(rendered.degraded).toEqual(['choices', 'approval', 'file', 'image']);
  });

  it('splits long replies at paragraph breaks and stays under the limit', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'x'.repeat(900)}`);
    const rendered = new TelegramRenderer().render(text(paragraphs.join('\n\n')));

    expect(rendered.chunks.length).toBeGreaterThan(1);
    for (const chunk of rendered.chunks) expect(chunk.length).toBeLessThanOrEqual(3800);
    expect(rendered.chunks.join('\n')).toContain('Paragraph 5');
  });

  it('hard-splits a single very long line', () => {
    const chunks = splitMarkdown('y'.repeat(250), 100);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join('')).toHaveLength(250);
  });
});
