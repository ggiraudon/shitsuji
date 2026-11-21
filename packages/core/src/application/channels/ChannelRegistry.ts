import type { ChannelAdapter, ChannelId } from '../../ports/ChannelAdapter.js';

/**
 * The channels this process runs, filled by plugins. The core never names a channel: it looks one up
 * by id when a reply says where to go (F06).
 */
export class ChannelRegistry {
  /** The adapters by id, in registration order; ids are the reply-channel prefixes. */
  private readonly byId = new Map<ChannelId, ChannelAdapter>();

  /** Registers an adapter; a duplicate id is a plugin bug and throws. */
  add(adapter: ChannelAdapter): void {
    if (this.byId.has(adapter.id)) {
      throw new Error(`Channel "${adapter.id}" is already registered`);
    }
    this.byId.set(adapter.id, adapter);
  }

  /** The adapter with this id, or undefined when no plugin registered it. */
  get(id: ChannelId): ChannelAdapter | undefined {
    return this.byId.get(id);
  }

  /** Every adapter in registration order; `Shitsuji.start` starts them in this order. */
  all(): readonly ChannelAdapter[] {
    return [...this.byId.values()];
  }

  /** How many adapters are registered, for the startup banner and `/status`. */
  get size(): number {
    return this.byId.size;
  }
}
