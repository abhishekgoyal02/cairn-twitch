import type { ChatMessage } from '@twurple/chat';
import type { NormalizedChatMessage } from './types.js';

export function normalizeMessage(
  channel: string,
  user: string,
  text: string,
  message: ChatMessage,
): NormalizedChatMessage | null {
  const id = message.id?.trim();
  if (!id) return null;

  return {
    id,
    channel: channel.replace(/^#/, '').toLowerCase(),
    sender: user.toLowerCase(),
    senderId: message.userInfo.userId,
    displayName: message.userInfo.displayName ?? user,
    text,
    timestamp: message.date ?? new Date(),
    isBroadcaster: message.userInfo.isBroadcaster,
    isModerator: message.userInfo.isMod,
    replyToMessageId: message.parentMessageId ?? undefined,
    replyToDisplayName: message.parentMessageUserDisplayName ?? undefined,
  };
}
