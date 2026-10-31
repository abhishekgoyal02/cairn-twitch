import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GovernanceService } from '../src/chat/governance-service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';
import type { StoneNote } from '../src/vault/stone-schema.js';

const roots: string[] = [];
const msg = (overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage => ({
  id: 'mod-msg', channel: 'channel', sender: 'mod', displayName: 'Mod', text: '', timestamp: new Date('2026-10-28T18:42:10.000Z'), isModerator: true, isBroadcaster: false, ...overrides,
});
const note = (id = 'st_a1b2c3'): StoneNote => ({ frontmatter: { id, type: 'stone', title: 'Kevin', status: 'unconfirmed', created: '2026-10-28T18:42:10.000Z', author: 'Viewer', source: [{ msg_id: 'source-1', ts: '2026-10-28T18:42:08.000Z' }] }, body: 'Kevin is the boss.' });

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-governance-')); roots.push(root);
  const writer = new StoneVaultWriter(root); const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
  const file = await writer.writeStone(note()); index.upsert(note(), file.relativePath);
  return { root, writer, index, service: new GovernanceService({ vaultPath: root, writer, index, idFactory: () => 'st_d4e5f6' }) };
}

describe('GovernanceService', () => {
  it('canonizes only with trusted authorization', async () => {
    const { service, writer, index } = await setup();
    await expect(service.canon('st_a1b2c3', false)).resolves.toContain('Only moderators');
    await expect(service.canon('st_a1b2c3', true)).resolves.toContain('now canon');
    const updated = (await writer.findStone('st_a1b2c3'))?.note;
    expect(updated?.frontmatter.status).toBe('canon');
    expect(updated?.frontmatter.history?.map((event) => event.type)).toEqual(['canonized']); index.close();
  });
  it('preserves correction history and supersedes the original', async () => {
    const { service, writer, index } = await setup();
    await expect(service.correct('st_a1b2c3', 'Kevin was renamed after the second run.', msg(), true)).resolves.toContain('st_d4e5f6');
    const original = (await writer.findStone('st_a1b2c3'))?.note;
    const replacement = (await writer.findStone('st_d4e5f6'))?.note;
    expect(original?.frontmatter.status).toBe('superseded');
    expect(original?.frontmatter.history?.[0]).toMatchObject({ type: 'superseded', relatedNoteId: 'st_d4e5f6' });
    expect(replacement?.frontmatter.supersedes).toBe('st_a1b2c3');
    expect(replacement?.frontmatter.history?.find((event) => event.type === 'corrected')).toMatchObject({ relatedNoteId: 'st_a1b2c3' }); index.close();
  });
  it('moves authorized notes to trash and rejects unknown IDs', async () => {
    const { service, root, writer, index } = await setup();
    await expect(service.forget('missing', true)).resolves.toContain('Unknown');
    await expect(service.forget('st_a1b2c3', true)).resolves.toContain('trash');
    await expect(service.forget('st_a1b2c3', true)).resolves.toContain('already in trash');
    expect((await fs.readdir(path.join(root, '_trash'))).length).toBe(1);
    expect((await writer.findTrashedStone('st_a1b2c3'))?.note.frontmatter.history?.[0]?.type).toBe('forgotten'); index.close();
  });
});
