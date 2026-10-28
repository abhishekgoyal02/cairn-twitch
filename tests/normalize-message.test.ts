import { describe, expect, it } from 'vitest';
import { normalizeMessage } from '../src/chat/normalize-message.js';

const baseMessage = {
  id: 'twitch-message-1',
  date: new Date('2026-10-28T12:00:00.000Z'),
  userInfo: {
    displayName: 'ExampleViewer',
    isBroadcaster: false,
    isMod: true,
  },
} as any;

describe('normalizeMessage', () => {
  it('preserves source and sender information', () => {
    expect(normalizeMessage('#CairnChannel', 'exampleviewer', '!ping', baseMessage)).toEqual({
      id: 'twitch-message-1',
      channel: 'cairnchannel',
      sender: 'exampleviewer',
      displayName: 'ExampleViewer',
      text: '!ping',
      timestamp: baseMessage.date,
      isBroadcaster: false,
      isModerator: true,
    });
  });

  it('returns null when the Twitch message ID is absent', () => {
    expect(normalizeMessage('channel', 'viewer', '!ping', { ...baseMessage, id: undefined })).toBeNull();
  });
});
