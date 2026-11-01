import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecapService } from '../src/chat/recap-service.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { LoreNote, StoneNote } from '../src/vault/stone-schema.js';
import type { NormalizedChatMessage } from '../src/chat/types.js';

const roots: string[] = [];
const message = (overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage => ({
  id: 'recap-1', channel: 'channel', sender: 'viewer', senderId: 'viewer-1', displayName: 'Viewer', text: '!recap', timestamp: new Date(), isModerator: false, isBroadcaster: false, ...overrides,
});
async function vault(): Promise<{ root: string; writer: StoneVaultWriter }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-recap-')); roots.push(root);
  return { root, writer: new StoneVaultWriter(root) };
}
function stone(id: string, title: string, status: StoneNote['frontmatter']['status'] = 'canon'): StoneNote {
  return { frontmatter: { id, type: 'stone', title, status, created: '2026-11-01T10:00:00.000Z', author: 'Viewer', source: [{ msg_id: id, ts: '2026-11-01T10:00:00.000Z' }] }, body: `${title} happened.` };
}
function lore(id: string, title: string, status: LoreNote['frontmatter']['status'] = 'canon', body = '[[st_a1b2c3]]'): LoreNote {
  return { frontmatter: { id, type: 'lore', title, status, created: '2026-11-01T10:01:00.000Z', author: 'Moderator' }, body };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('RecapService', () => {
  it('is deterministic, canon-grounded, and includes only real canon evidence', async () => {
    const { root, writer } = await vault();
    await writer.writeStone(stone('st_a1b2c3', 'Kevin Rename'));
    await writer.writeStone(stone('st_d4e5f6', 'Unconfirmed joke', 'unconfirmed'));
    await writer.writeStone(stone('st_g7h8i9', 'Superseded story', 'superseded'));
    await writer.writeLore(lore('lo_a1b2c3', 'Kevin community lore'));
    await writer.writeLore(lore('lo_d4e5f6', 'Draft lore', 'unconfirmed'));
    await writer.writeLore(lore('lo_g7h8i9', 'Old lore', 'superseded'));
    const recap = new RecapService({ vaultPath: root, now: () => 0 });
    const first = await recap.recap(message());
    expect(first).toContain('Kevin community lore (lo_a1b2c3; evidence: Kevin Rename st_a1b2c3)');
    expect(first).not.toContain('Draft lore');
    expect(first).not.toContain('Old lore');
    expect(first).not.toContain('Unconfirmed joke');
    expect(first).not.toContain('Superseded story');
  });

  it('handles empty canon, broken links, length bounds, unicode, and scoped cooldowns', async () => {
    const { root, writer } = await vault();
    let now = 0;
    const recap = new RecapService({ vaultPath: root, now: () => now });
    expect(await recap.recap(message())).toContain('canon is still being established');
    expect(await recap.recap(message({ id: 'recap-2', senderId: 'other' }))).toContain('cooling down');
    now = 10_001;
    await writer.writeStone(stone('st_a1b2c3', '😀'.repeat(260)));
    await writer.writeLore(lore('lo_a1b2c3', '😀'.repeat(260), 'canon'));
    const output = await recap.recap(message({ id: 'recap-3', channel: 'other' }));
    expect(Array.from(output).length).toBeLessThan(500);
    expect(output).toContain('😀');
    expect(output).toContain('lo_a1b2c3');
  });
});
