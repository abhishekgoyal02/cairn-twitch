import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopNoteRepository } from '../src/vault/loop-repository.js';
import { PersonNoteRepository, personIdForTwitchIdentity } from '../src/vault/person-repository.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import { type LoopNote, type StoneNote, validatePerson } from '../src/vault/stone-schema.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-person-loop-'));
  roots.push(value);
  return value;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true }))); });

function stone(id: string, author = 'Viewer'): StoneNote {
  return {
    frontmatter: {
      id, type: 'stone', title: `Stone ${id}`, status: 'unconfirmed', created: '2026-11-01T10:00:00.000Z', author,
      source: [{ msg_id: `message-${id}`, ts: '2026-11-01T10:00:00.000Z', author }],
    },
    body: 'A real community memory.',
  };
}

describe('PersonNoteRepository', () => {
  it('uses a stable, collision-safe identity mapping and updates only public display name and stone references', async () => {
    const vault = await root();
    const writer = new StoneVaultWriter(vault);
    await writer.writeStone(stone('st_a1b2c3'));
    await writer.writeStone(stone('st_d4e5f6'));
    const people = new PersonNoteRepository(vault, writer);

    const first = await people.getOrCreate('trusted-user-42', 'FirstName');
    expect(first.note.frontmatter.stoneIds).toEqual([]);
    expect(path.basename(first.filePath)).toBe(`${personIdForTwitchIdentity('trusted-user-42')}.md`);
    expect(await people.addContribution('trusted-user-42', 'RenamedName', 'st_a1b2c3')).toMatchObject({
      note: { frontmatter: { displayName: 'RenamedName', stoneIds: ['st_a1b2c3'] } },
    });
    await people.addContribution('trusted-user-42', 'RenamedName', 'st_a1b2c3');
    await people.addContribution('trusted-user-42', 'RenamedName', 'st_d4e5f6');
    expect(await people.contributedStoneIds('trusted-user-42')).toEqual(['st_a1b2c3', 'st_d4e5f6']);

    const sameNameDifferentIdentity = await people.getOrCreate('trusted-user-99', 'RenamedName');
    expect(sameNameDifferentIdentity.note.frontmatter.id).not.toBe(first.note.frontmatter.id);
    expect(await fs.readFile(first.filePath, 'utf8')).not.toContain('trusted-user-42');
  });

  it('rejects extra profile fields, unsafe identities, and nonexistent contribution targets', async () => {
    const vault = await root();
    const writer = new StoneVaultWriter(vault);
    const people = new PersonNoteRepository(vault, writer);
    expect(() => personIdForTwitchIdentity('../unsafe')).toThrow(/identity/i);
    await expect(people.addContribution('viewer', 'Viewer', 'st_a1b2c3')).rejects.toThrow(/does not exist/i);
    expect(() => validatePerson({
      frontmatter: { id: personIdForTwitchIdentity('viewer'), type: 'person', displayName: 'Viewer', stoneIds: [], bio: 'not allowed' } as never,
      body: '',
    })).toThrow(/only public/i);
  });
});

describe('LoopNoteRepository', () => {
  it('creates, lists, finds, and completes loops without replacing original metadata', async () => {
    const vault = await root();
    const writer = new StoneVaultWriter(vault);
    const loops = new LoopNoteRepository(writer, () => 'lp_a1b2c3');
    const created = await loops.create({
      title: 'Finish Kevin boss challenge', owner: 'Moderator', created: '2026-11-01T10:00:00.000Z',
      source: [{ msg_id: 'message-loop', ts: '2026-11-01T10:00:00.000Z', author: 'Moderator' }], body: 'Related: [[st_a1b2c3]]',
    });
    expect(created.note.frontmatter.status).toBe('open');
    expect((await loops.listOpen()).map((item) => item.note.frontmatter.id)).toEqual(['lp_a1b2c3']);
    expect((await loops.find('lp_a1b2c3'))?.note.frontmatter.owner).toBe('Moderator');

    const completed = await loops.complete('lp_a1b2c3', '2026-11-01T11:00:00.000Z');
    expect(completed.frontmatter.status).toBe('done');
    expect(completed.frontmatter.title).toBe('Finish Kevin boss challenge');
    expect(completed.frontmatter.source?.[0]?.msg_id).toBe('message-loop');
    expect(completed.frontmatter.history?.map((event) => event.type)).toEqual(['created', 'completed']);
    expect(await loops.listOpen()).toEqual([]);
    await expect(loops.complete('lp_a1b2c3', '2026-11-01T12:00:00.000Z')).rejects.toThrow(/already done/i);
    await expect(loops.complete('lp_missing', '2026-11-01T12:00:00.000Z')).rejects.toThrow(/Unknown/i);
  });

  it('rejects invalid owners and leaves an existing loop file intact when an atomic create conflicts', async () => {
    const vault = await root();
    const writer = new StoneVaultWriter(vault);
    const note: LoopNote = {
      frontmatter: { id: 'lp_z9y8x7', type: 'loop', title: 'One loop', status: 'open', created: '2026-11-01T10:00:00.000Z', owner: 'Moderator' },
      body: '',
    };
    const first = await writer.writeLoop(note);
    const before = await fs.readFile(first.absolutePath, 'utf8');
    await expect(writer.writeLoop(note)).rejects.toThrow(/already exists/i);
    expect(await fs.readFile(first.absolutePath, 'utf8')).toBe(before);
    const loops = new LoopNoteRepository(writer, () => 'lp_q1w2e3');
    await expect(loops.create({ title: 'No owner', owner: ' ', created: '2026-11-01T10:00:00.000Z' })).rejects.toThrow(/owner/i);
  });

  it('retries a generated ID collision without duplicating the existing loop', async () => {
    const vault = await root();
    const writer = new StoneVaultWriter(vault);
    await writer.writeLoop({
      frontmatter: { id: 'lp_a1b2c3', type: 'loop', title: 'Existing', status: 'open', created: '2026-11-01T10:00:00.000Z', owner: 'Moderator' },
      body: '',
    });
    const ids = ['lp_a1b2c3', 'lp_d4e5f6'];
    const loops = new LoopNoteRepository(writer, () => ids.shift() ?? 'lp_d4e5f6');
    expect((await loops.create({ title: 'New loop', owner: 'Moderator', created: '2026-11-01T10:01:00.000Z' })).note.frontmatter.id).toBe('lp_d4e5f6');
    expect((await loops.list()).map((entry) => entry.note.frontmatter.id).sort()).toEqual(['lp_a1b2c3', 'lp_d4e5f6']);
  });
});
