import { describe, expect, it, vi } from 'vitest';
import { MessageProcessor } from '../src/chat/process-message.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';

const message = (overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage => ({
  id: 'message-1',
  channel: 'channel',
  sender: 'viewer',
  displayName: 'Viewer',
  text: '!ping',
  timestamp: new Date(),
  isBroadcaster: false,
  isModerator: false,
  ...overrides,
});

describe('MessageProcessor', () => {
  it('replies once to !ping', async () => {
    const reply = vi.fn();
    const log = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, log });
    await processor.process(message());
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('channel', 'Cairn is online.');
    expect(log).toHaveBeenCalledWith('Recognized !ping from viewer in #channel.');
    expect(log).toHaveBeenCalledWith('Attempting to send !ping reply in #channel.');
  });

  it('does not reply to a duplicate message ID', async () => {
    const reply = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply });
    await processor.process(message());
    await processor.process(message());
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('ignores the bot own messages', async () => {
    const reply = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'CairnBot', reply });
    await processor.process(message({ sender: 'cairnbot' }));
    expect(reply).toHaveBeenCalledTimes(0);
  });

  it('ignores a self-message by authenticated Twitch user ID before stone handling', async () => {
    const reply = vi.fn();
    const stone = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'hackathonpart', botUserId: 'bot-123', reply, stone });
    await processor.process(message({ id: 'self-id', sender: 'different-login', senderId: 'bot-123', text: '!stone must not persist' }));
    expect(stone).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('matches self usernames case-insensitively and still accepts another viewer', async () => {
    const reply = vi.fn();
    const stone = vi.fn().mockResolvedValue('Stone saved: st_a1b2c3 (unconfirmed).');
    const processor = new MessageProcessor({ botUsername: 'HackathonPart', reply, stone });
    await processor.process(message({ id: 'self-case', sender: 'HACKATHONPART', text: '!stone ignore me' }));
    await processor.process(message({ id: 'viewer-case', sender: 'TestViewer', text: '!stone accept me' }));
    expect(stone).toHaveBeenCalledTimes(1);
    expect(stone).toHaveBeenCalledWith(expect.objectContaining({ sender: 'TestViewer' }), 'accept me');
  });

  it('replies to testviewer but ignores the configured bot username', async () => {
    const reply = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'hackathonpart', reply });

    await processor.process(message({ id: 'testviewer-ping', sender: 'testviewer' }));
    expect(reply).toHaveBeenCalledWith('channel', 'Cairn is online.');

    await processor.process(message({ id: 'bot-ping', sender: 'hackathonpart' }));
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('ignores ID-less events before command execution', async () => {
    const reply = vi.fn();
    const log = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, log });
    await processor.process(null);
    expect(reply).toHaveBeenCalledTimes(0);
    expect(log).toHaveBeenCalledWith('Ignored chat event without a usable message ID.');
  });

  it('ignores ordinary and unknown commands', async () => {
    const reply = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply });
    await processor.process(message({ id: 'ordinary', text: 'hello' }));
    await processor.process(message({ id: 'unknown', text: '!unknown' }));
    expect(reply).toHaveBeenCalledTimes(0);
  });

  it('reports reply failures without throwing', async () => {
    const reply = vi.fn().mockRejectedValue(new Error('send failed'));
    const log = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, log });
    await expect(processor.process(message())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('Failed to send !ping reply in #channel.');
  });

  it('routes !stone to its handler and replies with the handler result', async () => {
    const reply = vi.fn();
    const stone = vi.fn().mockResolvedValue('Stone saved: st_a1b2c3 (unconfirmed).');
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, stone });
    await processor.process(message({ text: '!stone Kevin is the boss' }));
    await processor.process(message({ text: '!stone Kevin is the boss' }));
    expect(stone).toHaveBeenCalledWith(expect.objectContaining({ sender: 'viewer' }), 'Kevin is the boss');
    expect(stone).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('channel', 'Stone saved: st_a1b2c3 (unconfirmed).');
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('routes !why once and deduplicates repeated deliveries', async () => {
    const reply = vi.fn();
    const why = vi.fn().mockResolvedValue('Unconfirmed: Kevin is the boss. Sources: st_a1b2c3 (unconfirmed).');
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, why });
    await processor.process(message({ id: 'why-1', text: '!why Kevin' }));
    await processor.process(message({ id: 'why-1', text: '!why Kevin' }));
    expect(why).toHaveBeenCalledTimes(1);
    expect(why).toHaveBeenCalledWith('Kevin');
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('routes public recap and mystones using the trusted normalized message without argument spoofing', async () => {
    const reply = vi.fn();
    const recap = vi.fn().mockResolvedValue('Welcome to Cairn.');
    const mystones = vi.fn().mockResolvedValue('You have added 1 stone.');
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, recap, mystones });
    await processor.process(message({ id: 'recap-1', text: '!recap', senderId: 'trusted-viewer' }));
    await processor.process(message({ id: 'my-1', text: '!mystones another-viewer', senderId: 'trusted-viewer' }));
    expect(recap).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'trusted-viewer' }));
    expect(mystones).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'trusted-viewer' }));
    expect(reply).toHaveBeenCalledWith('channel', 'Welcome to Cairn.');
    expect(reply).toHaveBeenCalledWith('channel', 'You have added 1 stone.');
  });

  it('rejects governance commands from viewers without invoking the handler', async () => {
    const reply = vi.fn();
    const canon = vi.fn();
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, canon });
    await processor.process(message({ id: 'viewer-canon', text: '!canon st_a1b2c3', isModerator: false, isBroadcaster: false }));
    expect(canon).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('channel', 'Only moderators or the broadcaster can use that command.');
  });

  it('routes promise and done through the established moderator gate and preserves command arguments', async () => {
    const reply = vi.fn();
    const promise = vi.fn().mockResolvedValue('Promise recorded: lp_a1b2c3 (open).');
    const done = vi.fn().mockResolvedValue('Loop lp_a1b2c3 is completed.');
    const processor = new MessageProcessor({ botUsername: 'cairnbot', reply, promise, done });
    await processor.process(message({ id: 'promise-viewer', text: '!promise no access' }));
    expect(promise).not.toHaveBeenCalled();
    await processor.process(message({ id: 'promise-mod', text: '!promise Finish the Kevin challenge', isModerator: true, senderId: 'trusted-mod' }));
    await processor.process(message({ id: 'done-mod', text: '!done lp_a1b2c3', isBroadcaster: true, senderId: 'trusted-broadcaster' }));
    expect(promise).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'trusted-mod', isModerator: true }), 'Finish the Kevin challenge');
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'trusted-broadcaster', isBroadcaster: true }), 'lp_a1b2c3');
    expect(reply).toHaveBeenCalledWith('channel', 'Promise recorded: lp_a1b2c3 (open).');
    expect(reply).toHaveBeenCalledWith('channel', 'Loop lp_a1b2c3 is completed.');
    await processor.process(message({ id: 'promise-mod', text: '!promise Finish the Kevin challenge', isModerator: true, senderId: 'trusted-mod' }));
    expect(promise).toHaveBeenCalledTimes(1);
  });
});
