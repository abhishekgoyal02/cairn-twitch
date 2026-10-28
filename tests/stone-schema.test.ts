import { describe, expect, it } from 'vitest';
import { parseStone, serializeStone, StoneValidationError, validateStone, type StoneNote } from '../src/vault/stone-schema.js';

const validNote = (): StoneNote => ({
  frontmatter: {
    id: 'st_k3f9a2',
    type: 'stone',
    title: 'Kevin, the boss',
    status: 'unconfirmed',
    created: '2026-10-28T18:42:10.000Z',
    author: 'ExampleViewer',
    source: [{ msg_id: 'example-message-id', ts: '2026-10-28T18:42:08.000Z' }],
  },
  body: 'Chat renamed the boss Kevin after the failed speedrun attempt.',
});

describe('stone schema', () => {
  it('validates and round-trips Markdown front matter and body', () => {
    const parsed = parseStone(serializeStone(validNote()));
    expect(parsed).toEqual(validNote());
  });

  it.each([
    ['bad id', { id: 'stone-1' }],
    ['bad type', { type: 'lore' }],
    ['bad status', { status: 'draft' }],
    ['empty author', { author: '' }],
    ['empty body', { body: '  ' }],
  ])('rejects %s', (_label, overrides) => {
    const note = validNote();
    Object.assign(note.frontmatter, overrides);
    if ('body' in overrides) note.body = overrides.body as string;
    expect(() => validateStone(note)).toThrow(StoneValidationError);
  });

  it('requires a non-empty source with a message ID and timestamp', () => {
    const note = validNote();
    note.frontmatter.source = [];
    expect(() => validateStone(note)).toThrow(/source/);
    note.frontmatter.source = [{ msg_id: '', ts: 'not-a-time' }];
    expect(() => validateStone(note)).toThrow(/msg_id/);
    note.frontmatter.source = [{ msg_id: 'message-1' }];
    expect(() => validateStone(note)).toThrow(/source\[0\]\.ts/);
  });
});
