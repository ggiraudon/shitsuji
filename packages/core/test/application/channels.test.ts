import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../../src/application/channels/ChannelRegistry.js';
import { PlainTextRenderer } from '../../src/application/channels/PlainTextRenderer.js';
import {
  BaseChannelAdapter,
  type ChannelCapabilities,
  type ChannelTarget,
  type DeliveryReceipt,
  type OutboundMessage,
} from '../../src/ports/ChannelAdapter.js';

const caps = (over: Partial<ChannelCapabilities> = {}): ChannelCapabilities => ({
  markdown: 'none',
  buttons: false,
  files: false,
  images: false,
  voice: false,
  edits: false,
  maxMessageLength: 1000,
  ...over,
});

describe('PlainTextRenderer', () => {
  it('degrades links, choices, approvals and files to text', () => {
    const message: OutboundMessage = {
      intent: 'final',
      parts: [
        { kind: 'text', markdown: 'Here you go.' },
        { kind: 'link', url: 'https://example.com', label: 'Open' },
        {
          kind: 'choices',
          questionId: 'q1',
          options: [
            { id: 'a', label: 'Yes' },
            { id: 'b', label: 'No' },
          ],
        },
        { kind: 'approval', approvalId: 'a1', summary: 'Send the email?', actionLabel: 'Approve' },
        { kind: 'file', fileRef: { name: 'report.pdf' } },
        { kind: 'image', fileRef: { name: 'shot.png' } },
      ],
    };

    const rendered = new PlainTextRenderer().render(message, caps());

    expect(rendered.text).toContain('Open: https://example.com');
    expect(rendered.text).toContain('1. Yes\n2. No');
    expect(rendered.text).toContain('Send the email?');
    expect(rendered.text).toContain('[Approval needed: Approve]');
    expect(rendered.text).toContain('[file: report.pdf]');
    expect(rendered.text).toContain('[image: shot.png]');
    expect(rendered.degraded).toEqual(['link', 'choices', 'approval', 'file', 'image']);
  });

  it('keeps a markdown link when the channel renders markdown', () => {
    const rendered = new PlainTextRenderer().render(
      {
        intent: 'final',
        parts: [{ kind: 'link', url: 'https://example.com', label: 'Open' }],
      },
      caps({ markdown: 'full' }),
    );

    expect(rendered.text).toBe('[Open](https://example.com)');
    expect(rendered.degraded).toEqual([]);
  });

  it('truncates past the channel limit', () => {
    const rendered = new PlainTextRenderer().render(
      { intent: 'final', parts: [{ kind: 'text', markdown: 'x'.repeat(100) }] },
      caps({ maxMessageLength: 40 }),
    );

    expect(rendered.text.length).toBeLessThanOrEqual(40);
    expect(rendered.text.endsWith('… (truncated)')).toBe(true);
  });
});

class SilentAdapter extends BaseChannelAdapter {
  readonly id = 'silent';
  readonly capabilities = caps();
  async deliver(_target: ChannelTarget, _message: OutboundMessage): Promise<DeliveryReceipt> {
    return { delivered: true };
  }
}

describe('ChannelRegistry', () => {
  it('registers by id and refuses duplicates', () => {
    const registry = new ChannelRegistry();
    const adapter = new SilentAdapter();

    registry.add(adapter);

    expect(registry.get('silent')).toBe(adapter);
    expect(registry.all()).toEqual([adapter]);
    expect(registry.size).toBe(1);
    expect(() => registry.add(new SilentAdapter())).toThrow(/already registered/);
    expect(registry.get('missing')).toBeUndefined();
  });
});
