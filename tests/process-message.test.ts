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
});
