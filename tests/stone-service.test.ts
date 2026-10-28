import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StoneService } from '../src/chat/stone-service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-service-'));
  roots.push(root);
  return root;
};
const viewerMessage = (overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage => ({
  id: 'twitch-1',
  channel: 'channel',
  sender: 'testviewer',
  senderId: 'viewer-id',
  displayName: 'TestViewer',
  text: '!stone Kevin is the boss',
  timestamp: new Date('2026-10-28T18:42:08.000Z'),
  isBroadcaster: false,
  isModerator: false,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('StoneService', () => {
  it('writes one searchable stone and enforces per-viewer cooldown', async () => {
    const root = await makeRoot();
    let now = Date.parse('2026-10-28T18:42:10.000Z');
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const ids = ['st_a1b2c3', 'st_d4e5f6'];
    const service = new StoneService({
      vaultPath: root,
      writer: new StoneVaultWriter(root),
      index,
      now: () => now,
      idFactory: () => ids.shift() ?? 'st_g7h8i9',
    });
    expect(await service.create(viewerMessage(), 'Kevin is the boss')).toBe('Stone saved: st_a1b2c3 (unconfirmed).');
    expect(await service.create(viewerMessage({ id: 'twitch-2' }), 'Another stone')).toBe('You can add another stone in a little while.');
    now += 30_000;
    expect(await service.create(viewerMessage({ id: 'twitch-3' }), 'Another stone')).toContain('Stone saved:');
    expect(index.search('Kevin is the boss')).toHaveLength(1);
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(2);
    service.close();
  });

  it('rejects empty and overlong text without writing files', async () => {
    const root = await makeRoot();
    const service = new StoneService({ vaultPath: root, idFactory: () => 'st_a1b2c3' });
    expect(await service.create(viewerMessage(), ' ')).toBe('Usage: !stone <text>');
    expect(await service.create(viewerMessage(), '😀'.repeat(281))).toBe('Stone text must be 280 characters or fewer.');
    await expect(fs.readdir(path.join(root, 'stones'))).rejects.toMatchObject({ code: 'ENOENT' });
    service.close();
  });
});
