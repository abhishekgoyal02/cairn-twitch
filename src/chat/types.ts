export interface NormalizedChatMessage {
  id: string;
  channel: string;
  sender: string;
  senderId?: string;
  displayName: string;
  text: string;
  timestamp: Date;
  isBroadcaster: boolean;
  isModerator: boolean;
  replyToMessageId?: string;
  replyToDisplayName?: string;
}
