import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphService } from '../src/graph/service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import { serializeStone, type StoneNote } from '../src/vault/stone-schema.js';
import { reindexVault } from '../src/index/reindex.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-graph-'));
  roots.push(root);
  return root;
};
const note = (id: string, title: string, body: string, status: 'unconfirmed' | 'canon' | 'superseded' = 'unconfirmed'): StoneNote => ({
  frontmatter: {
    id,
    type: 'stone',
    title,
    status,
    created: '2026-10-28T18:42:10.000Z',
    author: 'Viewer',
    source: [{ msg_id: `message-${id}`, ts: '2026-10-28T18:42:08.000Z' }],
  },
  body,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('GraphService', () => {
  it('drains a filesystem change that arrives during initial reconciliation', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const { scanVault } = await import('../src/graph/scanner.js');
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({
      vaultPath: root,
      index,
      scan: async (vaultPath) => {
        const result = await scanVault(vaultPath);
        if (first) { first = false; await gate; }
        return result;
      },
    });
    const starting = service.start();
    await writer.writeStone(note('st_a1b2c3', 'During startup', 'Written while startup scans.'));
    release();
    await starting;
    expect(service.isReady()).toBe(true);
    expect(service.getSnapshot().nodes.map((node) => node.id)).toEqual(['st_a1b2c3']);
    await service.stop();
    index.close();
  });

  it('coalesces delayed unlink/add by stable ID without a false replacement', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    const original = await writer.writeStone(note('st_a1b2c3', 'Kevin', 'Kevin.'));
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index, debounceMs: 5, renameGraceMs: 100 });
    await service.start();
    const revisions: number[] = [];
    service.subscribe((snapshot) => revisions.push(snapshot.revision));
    await fs.unlink(original);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.getSnapshot().nodes).toHaveLength(1);
    const renamed = path.join(root, 'stones', 'renamed.md');
    await fs.writeFile(renamed, serializeStone(note('st_a1b2c3', 'Kevin renamed', 'Kevin.')), 'utf8');
    await service.flush();
    expect(service.getSnapshot().nodes).toHaveLength(1);
    expect(service.getSnapshot().nodes[0].id).toBe('st_a1b2c3');
    expect(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1])).toBe(true);
    await service.stop();
    index.close();
  });

  it('keeps the prior published snapshot when projection or index fails', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    await writer.writeStone(note('st_a1b2c3', 'Stable', 'Stable.'));
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index, debounceMs: 1 });
    await service.start();
    const before = service.getSnapshot();
    await fs.writeFile(path.join(root, 'stones', 'new.md'), serializeStone(note('st_d4e5f6', 'New', 'New.')), 'utf8');
    const failing = new GraphService({ vaultPath: root, index: index as unknown as SqliteIndex, project: () => { throw new Error('projection failure'); } });
    await expect(failing.start()).rejects.toThrow('projection failure');
    expect(failing.getSnapshot().nodes).toEqual([]);
    expect(service.getSnapshot().nodes).toEqual(before.nodes);
    await failing.stop();
    const failingIndex = { rebuild: () => { throw new Error('index failure'); } } as unknown as SqliteIndex;
    const indexFailure = new GraphService({ vaultPath: root, index: failingIndex });
    await expect(indexFailure.start()).rejects.toThrow('index failure');
    expect(indexFailure.getSnapshot().nodes).toEqual([]);
    await indexFailure.stop();
    await service.stop();
    index.close();
  });

  it('rebuilds the complete graph equivalently after deleting only the temporary index', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    await writer.writeStone(note('st_a1b2c3', 'Kevin', 'Kevin.'));
    await writer.writeStone(note('st_d4e5f6', 'Story', 'Story links [[Kevin]].'));
    const indexPath = path.join(root, '.cairn', 'index.sqlite');
    const index = new SqliteIndex(indexPath, root);
    const service = new GraphService({ vaultPath: root, index });
    await service.start();
    const canonical = (snapshot: ReturnType<GraphService['getSnapshot']>) => ({ nodes: snapshot.nodes, edges: snapshot.edges, diagnostics: snapshot.diagnostics });
    const before = canonical(service.getSnapshot());
    await service.stop();
    index.close();
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${indexPath}${suffix}`, { force: true });
    await reindexVault(root);
    const rebuiltIndex = new SqliteIndex(indexPath, root);
    const rebuilt = new GraphService({ vaultPath: root, index: rebuiltIndex });
    await rebuilt.start();
    expect(canonical(rebuilt.getSnapshot())).toEqual(before);
    await rebuilt.stop();
    rebuiltIndex.close();
  });
  it('applies a real filesystem add event without restarting', async () => {
    const root = await makeRoot();
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index, debounceMs: 10 });
    await service.start();
    await new StoneVaultWriter(root).writeStone(note('st_a1b2c3', 'Kevin', 'Kevin is the boss.'));
    const deadline = Date.now() + 2000;
    while (service.getSnapshot().nodes.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(service.getSnapshot().nodes).toHaveLength(1);
    await service.stop();
    index.close();
  });

  it('reconciles additions, edits, renames, links, invalid notes and deletions', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    const targetPath = await writer.writeStone(note('st_a1b2c3', 'Kevin', 'Kevin is the boss.'));
    const sourcePath = await writer.writeStone(note('st_d4e5f6', 'Story', 'The story points to [[Kevin]], [[Kevin|Boss]], and [[Kevin#origin]].'));
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index, debounceMs: 1 });
    await service.start();
    expect(service.getSnapshot().nodes.map((node) => node.id)).toEqual(['st_a1b2c3', 'st_d4e5f6']);
    expect(service.getSnapshot().edges).toHaveLength(1);

    const edited = note('st_a1b2c3', 'Kevin Updated', 'Kevin remains the boss.', 'canon');
    await fs.writeFile(targetPath, serializeStone(edited), 'utf8');
    await service.flush();
    expect(service.getSnapshot().nodes.find((node) => node.id === 'st_a1b2c3')).toMatchObject({ title: 'Kevin Updated', status: 'canon' });

    const renamedPath = path.join(root, 'stones', 'renamed-kevin.md');
    await fs.rename(targetPath, renamedPath);
    await service.flush();
    expect(service.getSnapshot().nodes.find((node) => node.id === 'st_a1b2c3')?.relativePath).toBe('stones/renamed-kevin.md');

    await fs.writeFile(sourcePath, serializeStone(note('st_d4e5f6', 'Story', 'The story points to [[Missing]].')), 'utf8');
    await service.flush();
    expect(service.getSnapshot().edges).toHaveLength(0);
    expect(service.getSnapshot().diagnostics.some((diagnostic) => diagnostic.kind === 'broken-link')).toBe(true);

    await fs.writeFile(renamedPath, '---\nid: broken\n---\ninvalid', 'utf8');
    await service.flush();
    expect(service.getSnapshot().nodes.find((node) => node.id === 'st_a1b2c3')).toBeDefined();
    expect(service.getSnapshot().diagnostics.some((diagnostic) => diagnostic.kind === 'invalid')).toBe(true);

    await fs.unlink(sourcePath);
    await service.flush();
    expect(service.getSnapshot().nodes.map((node) => node.id)).toEqual(['st_a1b2c3']);
    await service.stop();
    index.close();
  });

  it('detects duplicate IDs deterministically and excludes internal directories', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    await writer.writeStone(note('st_a1b2c3', 'First', 'First.'));
    await fs.writeFile(path.join(root, 'stones', 'zzz-duplicate.md'), serializeStone(note('st_a1b2c3', 'Second', 'Second.')), 'utf8');
    await fs.mkdir(path.join(root, '_trash'), { recursive: true });
    await fs.writeFile(path.join(root, '_trash', 'deleted.md'), serializeStone(note('st_d4e5f6', 'Trash', 'Trash.')), 'utf8');
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index });
    await service.start();
    const snapshot = service.getSnapshot();
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0].title).toBe('First');
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.kind === 'duplicate-id')).toBe(true);
    await service.stop();
    index.close();
  });

  it('starts with an empty graph and deterministic node/edge ordering', async () => {
    const root = await makeRoot();
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const service = new GraphService({ vaultPath: root, index });
    await service.start();
    const first = service.getSnapshot();
    await service.flush();
    const second = service.getSnapshot();
    expect(first.nodes).toEqual([]);
    expect(first.edges).toEqual([]);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
    await service.stop();
    index.close();
  });
});
