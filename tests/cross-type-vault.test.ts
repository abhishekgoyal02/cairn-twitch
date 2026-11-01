import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanVault } from '../src/graph/scanner.js';
import { projectGraph } from '../src/graph/projection.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { reindexVault } from '../src/index/reindex.js';
import { lintVault } from '../src/lint-vault.js';

const roots: string[] = [];
const personId = `pe_${'a'.repeat(64)}`;
async function setup(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-cross-type-'));
  roots.push(root);
  await Promise.all(['stones', 'lore', 'people', 'loops', 'streams', '_trash'].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  await fs.writeFile(path.join(root, 'stones', 'one.md'), `---\nid: st_a1b2c3\ntype: stone\ntitle: First stone\nstatus: canon\ncreated: 2026-11-01T10:00:00.000Z\nauthor: Viewer\nsource:\n  - msg_id: msg-one\n    ts: 2026-11-01T10:00:00.000Z\n---\nFirst evidence.\n`);
  await fs.writeFile(path.join(root, 'stones', 'two.md'), `---\nid: st_d4e5f6\ntype: stone\ntitle: Second stone\nstatus: unconfirmed\ncreated: 2026-11-01T10:01:00.000Z\nauthor: Other\nsource:\n  - msg_id: msg-two\n    ts: 2026-11-01T10:01:00.000Z\n---\nSecond evidence.\n`);
  await fs.writeFile(path.join(root, 'lore', 'lore.md'), `---\nid: lo_a1b2c3\ntype: lore\ntitle: Kevin lore\nstatus: canon\ncreated: 2026-11-01T10:02:00.000Z\nauthor: Moderator\n---\n[[st_a1b2c3]]\n`);
  await fs.writeFile(path.join(root, 'people', `${personId}.md`), `---\nid: ${personId}\ntype: person\ndisplayName: Viewer\nstoneIds:\n  - st_a1b2c3\n---\n[[st_a1b2c3]]\n`);
  await fs.writeFile(path.join(root, 'loops', 'loop.md'), `---\nid: lp_a1b2c3\ntype: loop\ntitle: Finish the challenge\nstatus: open\ncreated: 2026-11-01T10:03:00.000Z\nowner: Moderator\nsource:\n  - msg_id: msg-loop\n    ts: 2026-11-01T10:03:00.000Z\n---\n[[st_a1b2c3]]\n`);
  await fs.writeFile(path.join(root, 'streams', 'stream.md'), `---\nid: sr_${'c'.repeat(64)}\ntype: stream\nstreamId: stream-one\nbroadcasterId: broadcaster-one\nstatus: completed\nstarted: 2026-11-01T10:00:00.000Z\nended: 2026-11-01T11:00:00.000Z\nstoneIds:\n  - st_a1b2c3\nopenLoopIds:\n  - lp_a1b2c3\n---\n## Stones added\n- [[st_a1b2c3]]\n\n## Open loops at stream end\n- [[lp_a1b2c3]]\n`);
  await fs.writeFile(path.join(root, '_trash', 'forgotten.md'), `---\nid: st_z9y8x7\ntype: stone\ntitle: Forgotten\nstatus: unconfirmed\ncreated: 2026-11-01T10:04:00.000Z\nauthor: Viewer\nsource:\n  - msg_id: trash\n    ts: 2026-11-01T10:04:00.000Z\n---\nForgotten.\n`);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('cross-type vault scanning and rebuild', () => {
  it('accepts missing optional content directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-minimal-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'stones'), { recursive: true });
    expect(await scanVault(root)).toMatchObject({ notes: [], diagnostics: [] });
  });

  it('projects all valid note types and their declared relationships without duplicate edges', async () => {
    const root = await setup();
    const scan = await scanVault(root);
    const streamNoteId = `sr_${'c'.repeat(64)}`;
    expect(scan.notes.map((record) => record.note.frontmatter.id).sort()).toEqual(['lo_a1b2c3', 'lp_a1b2c3', personId, streamNoteId, 'st_a1b2c3', 'st_d4e5f6']);
    expect(scan.paths.has('_trash/forgotten.md')).toBe(false);
    const projected = projectGraph(scan.notes, 1);
    expect(projected.nodes.map((node) => node.id).sort()).toEqual(['lo_a1b2c3', 'lp_a1b2c3', personId, streamNoteId, 'st_a1b2c3', 'st_d4e5f6']);
    expect(projected.nodes.find((node) => node.id === personId)).toMatchObject({ type: 'person', title: 'Viewer', contributedStoneCount: 1 });
    expect(projected.nodes.find((node) => node.id === streamNoteId)).toMatchObject({ type: 'stream', title: 'Stream session', status: 'completed', ended: '2026-11-01T11:00:00.000Z' });
    expect(projected.edges.map((edge) => edge.id)).toEqual([
      'lo_a1b2c3->st_a1b2c3:wikilink', 'lp_a1b2c3->st_a1b2c3:wikilink', `${personId}->st_a1b2c3:wikilink`, `${streamNoteId}->lp_a1b2c3:wikilink`, `${streamNoteId}->st_a1b2c3:wikilink`,
    ]);

    const summary = await reindexVault(root);
    expect(summary).toEqual({ indexed: 6, invalid: [] });
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    expect(index.list().map((note) => note.id).sort()).toEqual(['lo_a1b2c3', 'lp_a1b2c3', personId, streamNoteId, 'st_a1b2c3', 'st_d4e5f6']);
    index.close();
  });

  it('reports malformed people and broken active references without treating trashed notes as active', async () => {
    const root = await setup();
    const invalidPersonId = `pe_${'b'.repeat(64)}`;
    await fs.writeFile(path.join(root, 'people', 'wrong-name.md'), `---\nid: ${invalidPersonId}\ntype: person\ndisplayName: Other\nstoneIds:\n  - st_z9y8x7\n---\n[[st_z9y8x7]]\n`);
    const lint = await lintVault(root);
    expect(lint.errors.some((error) => /missing stone|filename|trashed|unresolved/i.test(error.reason))).toBe(true);
    const projected = projectGraph((await scanVault(root)).notes, 2);
    expect(projected.nodes.some((node) => node.id === invalidPersonId)).toBe(false);
    expect(projected.edges.some((edge) => edge.source === invalidPersonId || edge.target === 'st_z9y8x7')).toBe(false);
  });
});
