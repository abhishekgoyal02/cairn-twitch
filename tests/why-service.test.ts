import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WhyService } from '../src/chat/why-service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { StoneNote, StoneStatus } from '../src/vault/stone-schema.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-why-'));
  roots.push(root);
  return root;
};

const makeNote = (id: string, body: string, status: StoneStatus = 'unconfirmed'): StoneNote => ({
  frontmatter: {
    id,
    type: 'stone',
    title: body.slice(0, 30),
    status,
    created: '2026-10-28T18:42:10.000Z',
    author: 'Viewer',
    source: [{ msg_id: `message-${id}`, ts: '2026-10-28T18:42:08.000Z' }],
  },
  body,
});

const setup = async (...notes: StoneNote[]) => {
  const root = await makeRoot();
  const writer = new StoneVaultWriter(root);
  const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
  for (const note of notes) {
    const file = await writer.writeStone(note);
    index.upsert(note, path.relative(root, file));
  }
  return { root, index, service: new WhyService({ vaultPath: root, index }) };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('WhyService', () => {
  it('retrieves validated evidence and cites the stable stone ID', async () => {
    const cards: unknown[] = [];
    const { root, index } = await setup(makeNote('st_a1b2c3', 'Chat renamed the boss Kevin after a failed speedrun attempt.'));
    const service = new (WhyService)({ vaultPath: root, index, onCard: (card) => cards.push(card) });
    await expect(service.answer('Kevin')).resolves.toBe(
      'Unconfirmed: Chat renamed the boss Kevin after a failed speedrun attempt. Sources: st_a1b2c3 (unconfirmed).',
    );
    expect(cards).toHaveLength(1);
    index.close();
  });

  it('prefers canon evidence and excludes superseded notes', async () => {
    const { service, index } = await setup(
      makeNote('st_a1b2c3', 'Kevin is the boss.', 'unconfirmed'),
      makeNote('st_d4e5f6', 'Kevin is the boss.', 'canon'),
      makeNote('st_g7h8i9', 'Kevin was once called Terry.', 'superseded'),
    );
    const answer = await service.answer('Kevin');
    expect(answer).toContain('st_d4e5f6 (canon)');
    expect(answer).not.toContain('st_g7h8i9');
    expect(answer).not.toContain('Unconfirmed:');
    index.close();
  });

  it('returns exact missing and empty-topic responses', async () => {
    const cards: unknown[] = [];
    const { root, index } = await setup();
    const service = new (WhyService)({ vaultPath: root, index, onCard: (card) => cards.push(card) });
    await expect(service.answer('unknown lore')).resolves.toBe('Not in the vault yet.');
    await expect(service.answer('   ')).resolves.toBe('Usage: !why <topic>');
    expect(cards).toHaveLength(0);
    index.close();
  });

  it('handles punctuation, quotes, Unicode, malformed input, and conflicting evidence safely', async () => {
    const { service, index } = await setup(
      makeNote('st_a1b2c3', 'The café clue mentions Kevin, the boss.'),
      makeNote('st_d4e5f6', 'The café clue mentions a different Kevin story.'),
    );
    await expect(service.answer('"Kevin"?!')).resolves.toContain('Sources:');
    await expect(service.answer('café')).resolves.toContain('Sources:');
    await expect(service.answer('"unterminated [')).resolves.toBe('Not in the vault yet.');
    index.close();
  });

  it('never trusts deleted or malformed Markdown referenced by the index', async () => {
    const root = await makeRoot();
    const writer = new StoneVaultWriter(root);
    const note = makeNote('st_a1b2c3', 'Kevin is in this note.');
    const file = await writer.writeStone(note);
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    index.upsert(note, path.relative(root, file));
    const logs: string[] = [];
    const service = new WhyService({ vaultPath: root, index, log: (entry) => logs.push(entry) });
    await fs.writeFile(file, '---\nid: broken\ntype: stone\n---\nMalformed', 'utf8');
    await expect(service.answer('Kevin')).resolves.toBe('Not in the vault yet.');
    expect(logs).toHaveLength(1);
    await fs.rm(file);
    await expect(service.answer('Kevin')).resolves.toBe('Not in the vault yet.');
    expect(logs).toHaveLength(2);
    index.close();
  });
});
