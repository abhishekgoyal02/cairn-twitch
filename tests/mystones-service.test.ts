import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MyStonesService } from '../src/chat/mystones-service.js';
import { PersonNoteRepository } from '../src/vault/person-repository.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { StoneNote } from '../src/vault/stone-schema.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';

const roots: string[] = [];
async function setup(): Promise<{ root: string; writer: StoneVaultWriter; people: PersonNoteRepository }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-mystones-')); roots.push(root);
  const writer = new StoneVaultWriter(root); return { root, writer, people: new PersonNoteRepository(root, writer) };
}
function message(overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage {
  return { id: 'my-1', channel: 'channel', sender: 'viewer', senderId: 'viewer-1', displayName: 'Same Name', text: '!mystones', timestamp: new Date(), isModerator: false, isBroadcaster: false, ...overrides };
}
function stone(id: string, title: string, created: string, status: StoneNote['frontmatter']['status'] = 'unconfirmed'): StoneNote {
  return { frontmatter: { id, type: 'stone', title, status, created, author: 'Same Name', source: [{ msg_id: id, ts: created }] }, body: title };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('MyStonesService', () => {
  it('returns only the sender contributions, sorted newest-first with stable ties', async () => {
    const { root, writer, people } = await setup();
    const notes = [
      stone('st_a1b2c3', 'Old', '2026-11-01T10:00:00.000Z'),
      stone('st_d4e5f6', 'New D', '2026-11-01T12:00:00.000Z', 'superseded'),
      stone('st_g7h8i9', 'New G', '2026-11-01T12:00:00.000Z'),
      stone('st_j1k2l3', 'Fourth', '2026-11-01T11:00:00.000Z'),
    ];
    for (const note of notes) await writer.writeStone(note);
    for (const note of notes) await people.addContribution('viewer-1', 'Same Name', note.frontmatter.id);
    await people.addContribution('viewer-2', 'Same Name', 'st_a1b2c3');
    const service = new MyStonesService({ vaultPath: root, people });
    const output = await service.list(message());
    expect(output).toContain('4 stones');
    expect(output).toContain('New D (st_d4e5f6), New G (st_g7h8i9), Fourth (st_j1k2l3)');
    expect(output).not.toContain('viewer-2');
    expect(await service.list(message({ senderId: 'viewer-2' }))).toContain('1 stone');
  });

  it('safely handles zero/missing identity and excludes missing or forgotten references', async () => {
    const { root, writer, people } = await setup();
    const note = stone('st_a1b2c3', 'Forgotten', '2026-11-01T10:00:00.000Z');
    const receipt = await writer.writeStone(note);
    await people.addContribution('viewer-1', 'Viewer', note.frontmatter.id);
    await writer.moveToTrash(receipt.absolutePath, note.frontmatter.id);
    const service = new MyStonesService({ vaultPath: root, people });
    expect(await service.list(message())).toContain('not added any active stones');
    expect(await service.list(message({ senderId: undefined }))).toContain('could not verify');
    expect(await service.list(message({ senderId: 'viewer-none' }))).toContain('not added any stones');
  });
});
