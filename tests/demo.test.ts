import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runDemo } from '../src/demo.js';
import { scanVault } from '../src/graph/scanner.js';
import { reindexVault } from '../src/index/reindex.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe('isolated offline demo', () => {
  it('replays the real command pipeline into a temporary vault and rebuilds the same graph', async () => {
    const demo = await runDemo({ port: 0, keep: true });
    cleanups.push(async () => { await demo.cleanup(); await fs.rm(demo.vaultPath, { recursive: true, force: true }); });
    expect(demo.vaultPath).not.toContain(path.join(process.cwd(), 'cairn-vault'));
    expect(demo.replies.join('\n')).toContain('Stone saved: st_d3m001');
    expect(demo.replies.join('\n')).toContain('Not in the vault yet.');
    expect(demo.replies.join('\n')).toContain('Loop lp_d3m001 is completed.');
    expect(demo.replies.join('\n')).toContain('You have added 2 stones.');
    expect(demo.replies.join('\n')).toContain('Community canon:');
    const scan = await scanVault(demo.vaultPath);
    expect(new Set(scan.notes.map((record) => record.note.frontmatter.type))).toEqual(new Set(['stone', 'lore', 'person', 'loop', 'stream']));
    expect(scan.notes.filter((record) => record.note.frontmatter.id === 'st_d3m002')).toHaveLength(1);
    expect(demo.graph.getSnapshot().nodes.map((node) => node.id).sort()).toEqual(scan.notes.map((record) => record.note.frontmatter.id).sort());
    const beforeReindex = { nodes: demo.graph.getSnapshot().nodes, edges: demo.graph.getSnapshot().edges };
    expect(await reindexVault(demo.vaultPath)).toMatchObject({ invalid: [] });
    await demo.graph.flush();
    expect({ nodes: demo.graph.getSnapshot().nodes, edges: demo.graph.getSnapshot().edges }).toEqual(beforeReindex);
    const response = await fetch(`http://${demo.server.getAddress().host}:${demo.server.getAddress().port}/api/graph`);
    expect(response.status).toBe(200);
    expect((await response.json()).nodes).toHaveLength(scan.notes.length);
    await demo.cleanup();
    expect(await fs.stat(demo.vaultPath)).toBeDefined(); // keep=true retains only this isolated fixture for test cleanup
  });

  it('is repeatable from a fresh isolated vault without reusing production data', async () => {
    const first = await runDemo({ port: 0, keep: true });
    const second = await runDemo({ port: 0, keep: true });
    cleanups.push(async () => { await first.cleanup(); await fs.rm(first.vaultPath, { recursive: true, force: true }); });
    cleanups.push(async () => { await second.cleanup(); await fs.rm(second.vaultPath, { recursive: true, force: true }); });
    const firstIds = (await scanVault(first.vaultPath)).notes.map((record) => record.note.frontmatter.id).sort();
    const secondIds = (await scanVault(second.vaultPath)).notes.map((record) => record.note.frontmatter.id).sort();
    expect(second.vaultPath).not.toBe(first.vaultPath);
    expect(secondIds).toEqual(firstIds);
  });
});
