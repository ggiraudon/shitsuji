import { describe, expect, it } from 'vitest';
import { asId } from '../../src/domain/model/ids.js';
import type { ChannelAdapter, OutboundMessage } from '../../src/ports/ChannelAdapter.js';

/** Every part kind, so an adapter must degrade what it cannot show without throwing. */
export const everyPart: OutboundMessage = {
  intent: 'final',
  parts: [
    { kind: 'text', markdown: 'hello' },
    { kind: 'file', fileRef: { name: 'a.txt' } },
    { kind: 'image', fileRef: { name: 'b.png' } },
    { kind: 'choices', questionId: 'q', options: [{ id: '1', label: 'Yes' }] },
    { kind: 'approval', approvalId: 'a', summary: 'Send it?', actionLabel: 'Approve' },
    { kind: 'link', url: 'https://example.com', label: 'there' },
  ],
};

/** What every ChannelAdapter must do, whatever its transport (F06, S30). */
export function describeChannelContract(name: string, create: () => ChannelAdapter) {
  describe(`${name}: channel contract`, () => {
    it('declares an id and usable capabilities', () => {
      const adapter = create();
      expect(adapter.id.length).toBeGreaterThan(0);
      expect(['full', 'basic', 'none']).toContain(adapter.capabilities.markdown);
      expect(adapter.capabilities.maxMessageLength).toBeGreaterThan(0);
    });

    it('starts, delivers an out-of-band message without throwing, and stops twice', async () => {
      const adapter = create();
      await adapter.start({
        receive: async () => ({
          kind: 'turn',
          sessionId: asId('session'),
          turnId: asId('turn'),
          steered: false,
        }),
      });

      const receipt = await adapter.deliver({ chatId: 'nobody-waiting' }, everyPart);

      expect(typeof receipt.delivered).toBe('boolean');
      await adapter.stop();
      await adapter.stop();
    });
  });
}
