import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StoneVaultWriter } from '../src/vault/writer.js';
import { parseStone, type StoneNote } from '../src/vault/stone-schema.js';

const tempRoots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-vault-'));
  tempRoots.push(root);
  return root;
};

const note: StoneNote = {
  frontmatter: {
    id: 'st_a1b2c3',
    type: 'stone',
    title: 'Unsafe --- title',
    status: 'unconfirmed',
    created: '2026-10-28T18:42:10.000Z',
    author: 'Viewer',
    source: [{ msg_id: 'message-1', ts: '2026-10-28T18:42:08.000Z' }],
  },
  body: 'Body with --- separators and **Markdown** content.',
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('StoneVaultWriter', () => {
  it('creates the vault layout and writes a readable Markdown note', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    const file = await writer.writeStone(note);
    expect(file).toContain(path.join('stones', '2026-10-28-'));
    expect(parseStone(await fs.readFile(file, 'utf8'))).toEqual(note);
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(1);
  });

  it('does not overwrite an existing target file', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    await writer.writeStone(note);
    await expect(writer.writeStone(note)).rejects.toThrow(/already exists/);
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(1);
  });
});
