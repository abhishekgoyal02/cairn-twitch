import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamService } from '../src/chat/stream-service.js';
import { StreamNoteRepository } from '../src/vault/stream-repository.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import { LoopNoteRepository } from '../src/vault/loop-repository.js';
import { StoneService } from '../src/chat/stone-service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { reindexVault } from '../src/index/reindex.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';

const roots: string[] = [];
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-stream-')); roots.push(root);
  const writer = new StoneVaultWriter(root); const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
  const streams = new StreamNoteRepository(writer);
  const service = new StreamService({ vaultPath: root, broadcasterId: 'broadcaster-1', streams, index });
  return { root, writer, index, streams, service };
}
function message(overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage {
  return { id: 'stone-message', channel: 'channel', sender: 'viewer', senderId: 'viewer-1', displayName: 'Viewer', text: '!stone memory', timestamp: new Date('2026-11-01T10:05:00.000Z'), isModerator: false, isBroadcaster: false, ...overrides };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('StreamService lifecycle', () => {
  it('persists exactly one active stream from trusted online data and ignores mismatches/duplicates', async () => {
    const { streams, service, index } = await setup();
    await service.onOnline({ broadcasterId: 'other', streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    expect(await streams.find('stream-1')).toBeUndefined();
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: '', startedAt: '2026-11-01T10:00:00.000Z' });
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: 'bad-time', startedAt: 'not-a-time' });
    expect(await streams.find('bad-time')).toBeUndefined();
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    const stream = await streams.find('stream-1');
    expect(stream?.note.frontmatter).toMatchObject({ streamId: 'stream-1', broadcasterId: 'broadcaster-1', status: 'active', started: '2026-11-01T10:00:00.000Z' });
    expect((await streams.unresolved())).toHaveLength(1);
    expect(index.list()).toHaveLength(0); // watcher/reconcile owns initial stream indexing
    index.close();
  });

  it('associates new stones only while their trusted event time is within an active stream', async () => {
    const { root, writer, service, streams, index } = await setup();
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    const stoneService = new StoneService({ vaultPath: root, writer, index, streamContext: service, idFactory: () => 'st_a1b2c3' });
    await stoneService.create(message(), 'A session memory');
    expect((await writer.findStone('st_a1b2c3'))?.note.frontmatter.streamId).toBe('stream-1');
    await service.onOffline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', occurredAt: '2026-11-01T11:00:00.000Z' });
    expect(await service.streamIdFor(message({ timestamp: new Date('2026-11-01T10:30:00.000Z') }))).toBeUndefined();
    expect((await streams.find('stream-1'))?.note.frontmatter.stoneIds).toEqual(['st_a1b2c3']);
    stoneService.close();
  });

  it('finalizes with real session stones and open loops, excludes done loops, and is idempotent', async () => {
    const { root, writer, streams, service, index } = await setup();
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    const loopRepo = new LoopNoteRepository(writer, () => 'lp_a1b2c3');
    await loopRepo.create({ title: 'Open promise', owner: 'Mod', created: '2026-11-01T10:01:00.000Z' });
    const doneRepo = new LoopNoteRepository(writer, () => 'lp_d4e5f6');
    await doneRepo.create({ title: 'Done promise', owner: 'Mod', created: '2026-11-01T10:02:00.000Z' });
    await doneRepo.complete('lp_d4e5f6', '2026-11-01T10:03:00.000Z');
    const stoneService = new StoneService({ vaultPath: root, writer, index, streamContext: service, idFactory: () => 'st_a1b2c3' });
    await stoneService.create(message(), 'Actual stream stone');
    await service.onOffline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', occurredAt: '2026-11-01T11:00:00.000Z' });
    await service.onOffline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', occurredAt: '2026-11-01T11:00:00.000Z' });
    const stream = await streams.find('stream-1');
    expect(stream?.note.frontmatter).toMatchObject({ status: 'completed', ended: '2026-11-01T11:00:00.000Z', stoneIds: ['st_a1b2c3'], openLoopIds: ['lp_a1b2c3'] });
    expect(stream?.note.body).toContain('[[st_a1b2c3]]');
    expect(stream?.note.body).toContain('[[lp_a1b2c3]]');
    expect(stream?.note.body).not.toContain('lp_d4e5f6');
    index.close();
    expect(await reindexVault(root)).toEqual({ indexed: 5, invalid: [] });
  });

  it('reconciles durable active sessions across restart without fabricating offline time', async () => {
    const { streams, service, index, root } = await setup();
    await service.onOnline({ broadcasterId: 'broadcaster-1', streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    const restarted = new StreamService({ vaultPath: root, broadcasterId: 'broadcaster-1', streams, index });
    await restarted.reconcile({ streamId: 'stream-1', startedAt: '2026-11-01T10:00:00.000Z' });
    expect(await restarted.streamIdFor(message())).toBe('stream-1');
    await restarted.reconcile(null);
    const interrupted = await streams.find('stream-1');
    expect(interrupted?.note.frontmatter.status).toBe('interrupted');
    expect(interrupted?.note.frontmatter.ended).toBeUndefined();
    expect(interrupted?.note.frontmatter.recoveryObservedAt).toBeDefined();
    index.close();
  });
});
