import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoneService } from '../src/chat/stone-service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';
import type { LlmAdapter } from '../src/intelligence/llm.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-service-'));
  roots.push(root);
  return root;
};
const viewerMessage = (overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage => ({
  id: 'twitch-1',
  channel: 'channel',
  sender: 'testviewer',
  senderId: 'viewer-id',
  displayName: 'TestViewer',
  text: '!stone Kevin is the boss',
  timestamp: new Date('2026-10-28T18:42:08.000Z'),
  isBroadcaster: false,
  isModerator: false,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('StoneService', () => {
  it('writes one searchable stone and enforces per-viewer cooldown', async () => {
    const root = await makeRoot();
    let now = Date.parse('2026-10-28T18:42:10.000Z');
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const ids = ['st_a1b2c3', 'st_d4e5f6'];
    const service = new StoneService({
      vaultPath: root,
      writer: new StoneVaultWriter(root),
      index,
      now: () => now,
      idFactory: () => ids.shift() ?? 'st_g7h8i9',
    });
    expect(await service.create(viewerMessage(), 'Kevin is the boss')).toBe('Stone saved: st_a1b2c3 (unconfirmed).');
    expect(await service.create(viewerMessage({ id: 'twitch-2' }), 'Another stone')).toBe('You can add another stone in a little while.');
    now += 30_000;
    expect(await service.create(viewerMessage({ id: 'twitch-3' }), 'Another stone')).toContain('Stone saved:');
    expect(index.search('Kevin is the boss')).toHaveLength(1);
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(2);
    expect((await new StoneVaultWriter(root).findStone('st_a1b2c3'))?.note.frontmatter.history?.[0]?.type).toBe('created');
    service.close();
  });

  it('rejects empty and overlong text without writing files', async () => {
    const root = await makeRoot();
    const service = new StoneService({ vaultPath: root, idFactory: () => 'st_a1b2c3' });
    expect(await service.create(viewerMessage(), ' ')).toBe('Usage: !stone <text>');
    expect(await service.create(viewerMessage(), '😀'.repeat(281))).toBe('Stone text must be 280 characters or fewer.');
    await expect(fs.readdir(path.join(root, 'stones'))).rejects.toMatchObject({ code: 'ENOENT' });
    service.close();
  });

  it('creates a validated lore note when the provider reports no suitable candidate', async () => {
    const root = await makeRoot();
    const llm: LlmAdapter = { suggestLinks: async () => ({ ids: [] }), suggestLore: async () => ({ title: 'Kevin lore', stoneIds: ['st_a1b2c3'] }), answerWhy: async () => ({ answer: '', citations: [] }) };
    const logs: string[] = [];
    const service = new StoneService({ vaultPath: root, llm, idFactory: () => 'st_a1b2c3', log: (entry) => logs.push(entry) });
    await service.create(viewerMessage(), 'Kevin is the boss');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lore = await fs.readdir(path.join(root, 'lore'));
    expect(lore, logs.join(' | ')).toHaveLength(1);
    expect((await fs.readFile(path.join(root, 'lore', lore[0]), 'utf8'))).toContain('[[st_a1b2c3]]');
    service.close();
  });

  it('creates lore when candidates exist but none is selected as related', async () => {
    const root = await makeRoot();
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const writer = new StoneVaultWriter(root);
    const existing = {
      frontmatter: { id: 'st_old001', type: 'stone' as const, title: 'Older Kevin', status: 'unconfirmed' as const, created: '2026-10-28T18:42:10.000Z', author: 'Viewer', source: [{ msg_id: 'old-msg', ts: '2026-10-28T18:42:08.000Z' }] },
      body: 'Kevin is remembered by chat.',
    };
    const oldReceipt = await writer.writeStone(existing);
    index.upsert(existing, oldReceipt.relativePath);
    const calls: string[] = [];
    const llm: LlmAdapter = {
      suggestLinks: async () => { calls.push('links'); return { ids: [] }; },
      suggestLore: async () => { calls.push('lore'); return { title: 'Kevin community lore', stoneIds: ['st_a1b2c3'] }; },
      answerWhy: async () => ({ answer: '', citations: [] }),
    };
    const service = new StoneService({ vaultPath: root, writer, index, llm, idFactory: () => 'st_a1b2c3' });
    await service.create(viewerMessage(), 'Kevin is the boss');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await fs.readdir(path.join(root, 'lore'))).toHaveLength(1);
    expect(calls).toEqual(['links', 'lore']);
    service.close();
  });

  it('records a real relationship update only after a validated link is persisted', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const existing = {
      frontmatter: { id: 'st_old001', type: 'stone' as const, title: 'Older Kevin', status: 'unconfirmed' as const, created: '2026-10-28T18:42:10.000Z', author: 'Viewer', source: [{ msg_id: 'old-msg', ts: '2026-10-28T18:42:08.000Z' }] },
      body: 'Kevin is remembered by chat.',
    };
    const receipt = await writer.writeStone(existing); index.upsert(existing, receipt.relativePath);
    const llm: LlmAdapter = { suggestLinks: async () => ({ ids: ['st_old001'] }), answerWhy: async () => ({ answer: '', citations: [] }) };
    const service = new StoneService({ vaultPath: root, writer, index, llm, idFactory: () => 'st_a1b2c3' });
    await service.create(viewerMessage(), 'Kevin is the boss');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await writer.findStone('st_a1b2c3'))?.note.frontmatter.history?.some((event) => event.type === 'links_updated')).toBe(true);
    service.close();
  });

  it('keeps durable success when candidate retrieval or background LLM work fails', async () => {
    const root = await makeRoot();
    const index = { upsert: vi.fn(), search: vi.fn(() => { throw new Error('search unavailable'); }), close: vi.fn() } as unknown as SqliteIndex;
    const llm: LlmAdapter = { suggestLinks: async () => { throw new Error('provider down'); }, answerWhy: async () => ({ answer: '', citations: [] }) };
    const logs: string[] = [];
    const service = new StoneService({ vaultPath: root, writer: new StoneVaultWriter(root), index, llm, log: (entry) => logs.push(entry), idFactory: () => 'st_a1b2c3' });
    await expect(service.create(viewerMessage(), 'Durable memory')).resolves.toContain('Stone saved: st_a1b2c3');
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(1);
    expect(logs.some((entry) => entry.includes('persisted'))).toBe(true);
    service.close();
  });

  it('reports index-pending while retaining the durable Markdown file', async () => {
    const root = await makeRoot();
    const index = { upsert: vi.fn(() => { throw new Error('index unavailable'); }), search: vi.fn(), close: vi.fn() } as unknown as SqliteIndex;
    const service = new StoneService({ vaultPath: root, writer: new StoneVaultWriter(root), index, idFactory: () => 'st_a1b2c3' });
    await expect(service.create(viewerMessage(), 'Index pending memory')).resolves.toContain('(index pending)');
    expect(await fs.readdir(path.join(root, 'stones'))).toHaveLength(1);
    service.close();
  });
});
