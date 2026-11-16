import type { ChannelAdapter, ChannelId } from '../../ports/ChannelAdapter.js';

/**
 * The channels this process runs, filled by plugins. The core never names a channel: it looks one up
 * by id when a reply says where to go (F06).
 */
export class ChannelRegistry {
  private readonly byId = new Map<ChannelId, ChannelAdapter>();

  add(adapter: ChannelAdapter): void {
    if (this.byId.has(adapter.id)) {
      throw new Error(`Channel "${adapter.id}" is already registered`);
    }
    this.byId.set(adapter.id, adapter);
  }

  get(id: ChannelId): ChannelAdapter | undefined {
    return this.byId.get(id);
  }

  all(): readonly ChannelAdapter[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
