import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { reindexVault } from '../src/index/reindex.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { StoneNote } from '../src/vault/stone-schema.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-index-'));
  roots.push(root);
  return root;
};

const makeNote = (id: string, body: string): StoneNote => ({
  frontmatter: {
    id,
    type: 'stone',
    title: 'Kevin lore',
    status: 'unconfirmed',
    created: '2026-10-28T18:42:10.000Z',
    author: 'Viewer',
    source: [{ msg_id: `message-${id}`, ts: '2026-10-28T18:42:08.000Z' }],
  },
  body,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('SqliteIndex and reindex', () => {
  it('supports FTS5 search and idempotent upserts', async () => {
    const root = await makeRoot();
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const note = makeNote('st_a1b2c3', 'The failed speedrun named Kevin.');
    index.upsert(note, 'stones/example.md');
    index.upsert(note, 'stones/example.md');
    expect(index.search('failed speedrun')).toHaveLength(1);
    expect(index.list()).toHaveLength(1);
    index.close();
  });

  it('rebuilds the index from Markdown and is stable across repeated runs', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    await writer.writeStone(makeNote('st_a1b2c3', 'The failed speedrun named Kevin.'));
    await writer.writeStone(makeNote('st_d4e5f6', 'Chat remembers the rematch.'));
    const first = await reindexVault(root);
    const indexPath = path.join(root, '.cairn', 'index.sqlite');
    const index = new SqliteIndex(indexPath, root);
    const firstResults = index.list();
    index.close();
    await fs.rm(indexPath);
    const second = await reindexVault(root);
    const rebuilt = new SqliteIndex(indexPath, root);
    const secondResults = rebuilt.list();
    rebuilt.close();
    expect(first).toEqual({ indexed: 2, invalid: [] });
    expect(second).toEqual(first);
    expect(secondResults).toEqual(firstResults);
  });

  it('reports malformed Markdown while indexing valid notes', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    await writer.writeStone(makeNote('st_a1b2c3', 'Valid note.'));
    await fs.writeFile(path.join(root, 'stones', 'broken.md'), '---\nid: bad\n---\nBroken', 'utf8');
    const summary = await reindexVault(root);
    expect(summary.indexed).toBe(1);
    expect(summary.invalid[0].file).toBe(path.join('stones', 'broken.md'));
  });

  it('rebuilds a lore note with an unquoted YAML timestamp', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'stones'), { recursive: true });
    await fs.mkdir(path.join(root, 'lore'), { recursive: true });
    await fs.writeFile(path.join(root, 'stones', 'stone.md'), [
      '---', 'id: st_a1b2c3', 'type: stone', 'title: Kevin', 'status: unconfirmed',
      "created: '2026-10-31T12:00:00.000Z'", 'author: Viewer', 'source:',
      '  - msg_id: message-1', "    ts: '2026-10-31T12:00:00.000Z'", '---', 'Kevin is the boss.', '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(root, 'lore', 'lore.md'), [
      '---', 'id: lo_a1b2c3', 'type: lore', 'title: Kevin lore', 'status: unconfirmed',
      'created: 2026-10-31T12:00:00.000Z', 'author: Viewer', '---', 'Related: [[st_a1b2c3]]', '',
    ].join('\n'), 'utf8');
    const summary = await reindexVault(root);
    expect(summary).toEqual({ indexed: 2, invalid: [] });
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const lore = index.list().find((entry) => entry.id === 'lo_a1b2c3');
    expect(lore).toMatchObject({ type: 'lore', created: '2026-10-31T12:00:00.000Z' });
    expect(typeof lore?.created).toBe('string');
    index.close();
  });
});
