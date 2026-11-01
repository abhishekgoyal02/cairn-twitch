import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphService } from '../src/graph/service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { reindexVault } from '../src/index/reindex.js';

const roots: string[] = [];
const personId = `pe_${'a'.repeat(64)}`;
const streamId = `sr_${'b'.repeat(64)}`;

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-graph-types-'));
  roots.push(root);
  await Promise.all(['stones', 'people', 'loops', 'streams', '_trash'].map((directory) => fs.mkdir(path.join(root, directory), { recursive: true })));
  await fs.writeFile(path.join(root, 'stones', 'stone.md'), `---\nid: st_a1b2c3\ntype: stone\ntitle: Evidence\nstatus: unconfirmed\ncreated: 2026-11-01T10:00:00.000Z\nauthor: Viewer\nsource:\n  - msg_id: msg-1\n    ts: 2026-11-01T10:00:00.000Z\n---\nEvidence.\n`);
  await fs.writeFile(path.join(root, 'people', `${personId}.md`), `---\nid: ${personId}\ntype: person\ndisplayName: Viewer\nstoneIds:\n  - st_a1b2c3\n---\n[[st_a1b2c3]]\n`);
  await fs.writeFile(path.join(root, 'loops', 'loop.md'), `---\nid: lp_a1b2c3\ntype: loop\ntitle: Finish challenge\nstatus: open\ncreated: 2026-11-01T10:01:00.000Z\nowner: Moderator\n---\n\n`);
  await fs.writeFile(path.join(root, 'streams', 'stream.md'), `---\nid: ${streamId}\ntype: stream\nstreamId: stream-one\nbroadcasterId: broadcaster-one\nstatus: completed\nstarted: 2026-11-01T10:00:00.000Z\nended: 2026-11-01T11:00:00.000Z\nstoneIds:\n  - st_a1b2c3\nopenLoopIds:\n  - lp_a1b2c3\n---\n## Stones added\n- [[st_a1b2c3]]\n\n## Open loops at stream end\n- [[lp_a1b2c3]]\n`);
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('GraphService note-type projection', () => {
  it('reconciles, edits, renames, removes, and rebuilds all valid new note types by stable ID', async () => {
    const root = await fixture();
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index, debounceMs: 1, renameGraceMs: 1 });
    await service.start();
    const canonical = () => {
      const snapshot = service.getSnapshot();
      return { nodes: snapshot.nodes, edges: snapshot.edges };
    };
    expect(service.getSnapshot().nodes.map((node) => node.type).sort()).toEqual(['loop', 'person', 'stone', 'stream']);
    expect(service.getSnapshot().edges.map((edge) => edge.id)).toEqual([
      `${personId}->st_a1b2c3:wikilink`, `${streamId}->lp_a1b2c3:wikilink`, `${streamId}->st_a1b2c3:wikilink`,
    ]);

    const personPath = path.join(root, 'people', `${personId}.md`);
    await fs.writeFile(personPath, `---\nid: ${personId}\ntype: person\ndisplayName: Updated Viewer\nstoneIds:\n  - st_a1b2c3\n---\n[[st_a1b2c3]]\n`);
    await service.flush();
    expect(service.getSnapshot().nodes.find((node) => node.id === personId)).toMatchObject({ title: 'Updated Viewer', type: 'person' });

    const renamed = path.join(root, 'loops', 'renamed-loop.md');
    await fs.rename(path.join(root, 'loops', 'loop.md'), renamed);
    await service.flush();
    expect(service.getSnapshot().nodes.filter((node) => node.id === 'lp_a1b2c3')).toHaveLength(1);

    const beforeReindex = canonical();
    await reindexVault(root);
    await service.flush();
    expect(canonical()).toEqual(beforeReindex);

    await fs.rename(path.join(root, 'streams', 'stream.md'), path.join(root, '_trash', 'stream.md'));
    await service.flush();
    expect(service.getSnapshot().nodes.some((node) => node.id === streamId)).toBe(false);
    expect(service.getSnapshot().edges.some((edge) => edge.source === streamId || edge.target === streamId)).toBe(false);
    await service.stop();
    index.close();
  });
});
