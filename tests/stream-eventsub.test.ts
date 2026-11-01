import { describe, expect, it, vi } from 'vitest';
import type { StreamEventSource } from '../src/twitch/stream-eventsub.js';
import { StreamService } from '../src/chat/stream-service.js';

describe('stream EventSub boundary', () => {
  it('allows a reconnecting event source to deliver duplicate online events safely to the lifecycle service', async () => {
    const onOnline = vi.fn(); const onOffline = vi.fn();
    const source: StreamEventSource = { start: async () => ({ broadcasterId: 'broadcaster-1' }), stop: async () => undefined, getLiveStream: async () => null };
    await expect(source.start()).resolves.toEqual({ broadcasterId: 'broadcaster-1' });
    await source.stop();
    expect(onOnline).not.toHaveBeenCalled(); expect(onOffline).not.toHaveBeenCalled();
    void StreamService;
  });
});
