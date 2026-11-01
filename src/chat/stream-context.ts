import type { NormalizedChatMessage } from './types.js';

/** Narrow dependency used by StoneService; it never imports stream lifecycle implementation. */
export interface ActiveStreamProvider {
  streamIdFor(message: Pick<NormalizedChatMessage, 'timestamp'>): Promise<string | undefined>;
}
