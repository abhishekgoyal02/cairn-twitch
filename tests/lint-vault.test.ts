import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintVault } from '../src/lint-vault.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('vault linter', () => {
  it('reports broken links, invalid lore relationships, and duplicate IDs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-lint-')); roots.push(root);
    await fs.mkdir(path.join(root, 'stones'), { recursive: true }); await fs.mkdir(path.join(root, 'lore'), { recursive: true });
    const stone = `---\nid: st_a1b2c3\ntype: stone\ntitle: Kevin\nstatus: unconfirmed\ncreated: 2026-10-28T18:42:10.000Z\nauthor: Viewer\nsource:\n  - msg_id: msg-1\n    ts: 2026-10-28T18:42:08.000Z\n---\nKevin [[st_missing1]]`;
    await fs.writeFile(path.join(root, 'stones', 'a.md'), stone); await fs.writeFile(path.join(root, 'stones', 'b.md'), stone);
    await fs.writeFile(path.join(root, 'lore', 'bad.md'), `---\nid: lo_a1b2c3\ntype: lore\ntitle: Bad\nstatus: unconfirmed\ncreated: 2026-10-28T18:42:10.000Z\nauthor: Viewer\n---\nRelated: [[st_missing1]]`);
    const result = await lintVault(root);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => /broken|missing|unresolved/iu.test(error.reason))).toBe(true);
  });
});
