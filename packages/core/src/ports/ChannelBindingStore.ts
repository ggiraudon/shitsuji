import type { OwnerId, SessionId } from '../domain/model/ids.js';
import type { Transaction } from './Repositories.js';

/**
 * One chat on one channel, bound to the owner. `verifiedAt` is set when the chat was paired; a binding
 * without it is not trusted for chat channels. `sessionId` lets a chat have its own conversation after
 * `/new`, so the main chat session is not forced on every channel (F06, S31).
 */
export interface ChannelBinding {
  channel: string;
  externalChatId: string;
  ownerId: OwnerId;
  verifiedAt?: Date;
  sessionId?: SessionId;
}

export interface ChannelBindingStore {
  get(
    channel: string,
    externalChatId: string,
    tx?: Transaction,
  ): Promise<ChannelBinding | undefined>;
  /** Creates or replaces a binding (pairing, or a new session for the chat). */
  upsert(binding: ChannelBinding, tx?: Transaction): Promise<void>;
  listByOwner(ownerId: OwnerId, tx?: Transaction): Promise<ChannelBinding[]>;
}
