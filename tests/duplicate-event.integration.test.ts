import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageProcessor } from '../src/chat/process-message.js';
import { normalizeMessage } from '../src/chat/normalize-message.js';
import { StoneService } from '../src/chat/stone-service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Twitch duplicate delivery integration', () => {
  it('persists one stone when the exact normalized Twitch event is delivered twice', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-dedup-integration-'));
    roots.push(root);
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new StoneService({ vaultPath: root, index, idFactory: () => 'st_a1b2c3' });
    const create = vi.spyOn(service, 'create');
    const replies: string[] = [];
    const processor = new MessageProcessor({
      botUsername: 'hackathonpart',
      reply: (_channel, text) => { replies.push(text); },
      stone: (incoming, body) => service.create(incoming, body),
    });

    const twitchEvent = {
      id: 'twitch-event-001',
      date: new Date('2026-10-31T12:00:00.000Z'),
      userInfo: {
        userId: 'viewer-001',
        displayName: 'TestViewer',
        isBroadcaster: false,
        isMod: false,
      },
    } as any;
    const normalized = normalizeMessage('#channel', 'testviewer', '!stone Kevin is the boss', twitchEvent);
    expect(normalized?.id).toBe('twitch-event-001');
    if (!normalized) throw new Error('expected a usable Twitch event');

    await processor.process(normalized);
    await processor.process(normalized);

    expect(create).toHaveBeenCalledTimes(1);
    expect(replies).toEqual(['Stone saved: st_a1b2c3 (unconfirmed).']);
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(1);
    expect(index.list()).toHaveLength(1);
    expect(index.list()[0].id).toBe('st_a1b2c3');
    service.close();
  });
});
