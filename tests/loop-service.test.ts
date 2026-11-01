import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopService } from '../src/chat/loop-service.js';
import { LoopNoteRepository } from '../src/vault/loop-repository.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { reindexVault } from '../src/index/reindex.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';

const roots: string[] = [];
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-loop-service-')); roots.push(root);
  const writer = new StoneVaultWriter(root);
  const ids = ['lp_a1b2c3', 'lp_d4e5f6'];
  const loops = new LoopNoteRepository(writer, () => ids.shift() ?? 'lp_z9y8x7');
  const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
  return { root, writer, loops, index, service: new LoopService({ vaultPath: root, writer, loops, index }) };
}
function message(overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage {
  return {
    id: 'promise-message', channel: 'channel', sender: 'mod-login', senderId: 'trusted-mod-id', displayName: 'Real Moderator', text: '',
    timestamp: new Date('2026-11-01T10:00:00.000Z'), isModerator: true, isBroadcaster: false, ...overrides,
  };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('LoopService', () => {
  it('creates an open promise from trusted moderator metadata and indexes the persisted note', async () => {
    const { loops, index, service } = await setup();
    await expect(service.promise(message(), '  Finish the Kevin boss challenge next stream  ', true)).resolves.toBe('Promise recorded: lp_a1b2c3 (open).');
    const record = await loops.find('lp_a1b2c3');
    expect(record?.note.frontmatter).toMatchObject({ title: 'Finish the Kevin boss challenge next stream', owner: 'Real Moderator', status: 'open', created: '2026-11-01T10:00:00.000Z' });
    expect(record?.note.frontmatter.source).toEqual([{ msg_id: 'promise-message', ts: '2026-11-01T10:00:00.000Z', author: 'Real Moderator' }]);
    expect(record?.note.frontmatter.history).toEqual([{ type: 'created', at: '2026-11-01T10:00:00.000Z' }]);
    expect(index.list().find((entry) => entry.id === 'lp_a1b2c3')?.status).toBe('open');
    index.close();
  });

  it('rejects unauthorized, malformed, empty, and overlong promise requests without files', async () => {
    const { root, service, index } = await setup();
    expect(await service.promise(message(), 'A promise', false)).toContain('Only moderators');
    expect(await service.promise(message(), '   ', true)).toContain('Usage:');
    expect(await service.promise(message(), '😀'.repeat(281), true)).toContain('280');
    await expect(fs.readdir(path.join(root, 'loops'))).rejects.toMatchObject({ code: 'ENOENT' });
    index.close();
  });

  it('allows legitimate missing optional source evidence without inventing it', async () => {
    const { loops, index, service } = await setup();
    await expect(service.promise(message({ id: '', timestamp: new Date('invalid') }), 'Promise without usable source', true)).resolves.toContain('Promise recorded');
    expect((await loops.find('lp_a1b2c3'))?.note.frontmatter.source).toBeUndefined();
    index.close();
  });

  it('completes exactly one open loop while preserving metadata, body, source and recording the real actor', async () => {
    const { root, loops, index, service } = await setup();
    await service.promise(message(), 'Finish challenge', true);
    const before = await loops.find('lp_a1b2c3');
    if (!before) throw new Error('expected loop');
    await fs.writeFile(before.filePath, (await fs.readFile(before.filePath, 'utf8')).replace(/\n$/u, '\nRelated: [[st_a1b2c3]]\n'));
    await expect(service.done(message({ id: 'done-message', displayName: 'Broadcaster', isBroadcaster: true }), 'lp_a1b2c3', true)).resolves.toBe('Loop lp_a1b2c3 is completed.');
    const after = await loops.find('lp_a1b2c3');
    expect(after?.note.frontmatter).toMatchObject({ title: 'Finish challenge', owner: 'Real Moderator', status: 'done', created: '2026-11-01T10:00:00.000Z' });
    expect(after?.note.frontmatter.source).toEqual(before.note.frontmatter.source);
    expect(after?.note.body).toContain('[[st_a1b2c3]]');
    expect(after?.note.frontmatter.history?.at(-1)).toMatchObject({ type: 'completed', actor: 'Broadcaster' });
    expect(await service.done(message({ id: 'done-again' }), 'lp_a1b2c3', true)).toBe('Loop lp_a1b2c3 is already completed.');
    expect(after?.note.frontmatter.history).toHaveLength(2);
    expect(index.list().find((entry) => entry.id === 'lp_a1b2c3')?.status).toBe('done');
    expect((await new LoopNoteRepository(new StoneVaultWriter(root)).find('lp_a1b2c3'))?.note.frontmatter.status).toBe('done');
    index.close();
    expect(await reindexVault(root)).toEqual({ indexed: 1, invalid: [] });
    const rebuilt = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    expect(rebuilt.list()).toMatchObject([{ id: 'lp_a1b2c3', status: 'done' }]);
    rebuilt.close();
  });

  it('rejects invalid IDs and serializes concurrent completion attempts without duplicate history', async () => {
    const { loops, service, index } = await setup();
    await service.promise(message(), 'Finish challenge', true);
    for (const id of ['', 'st_a1b2c3', 'lo_a1b2c3', 'pe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sp_a1b2c3']) {
      expect(await service.done(message(), id, true)).toBe('Invalid loop ID.');
    }
    expect(await service.done(message(), 'lp_d4e5f6', true)).toBe('Unknown loop ID: lp_d4e5f6.');
    const results = await Promise.all([service.done(message({ id: 'first' }), 'lp_a1b2c3', true), service.done(message({ id: 'second' }), 'lp_a1b2c3', true)]);
    expect(results.sort()).toEqual(['Loop lp_a1b2c3 is already completed.', 'Loop lp_a1b2c3 is completed.']);
    expect((await loops.find('lp_a1b2c3'))?.note.frontmatter.history?.filter((event) => event.type === 'completed')).toHaveLength(1);
    index.close();
  });
});
