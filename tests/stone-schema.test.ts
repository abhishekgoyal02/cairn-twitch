import { describe, expect, it } from 'vitest';
import { parseNote, parseStone, serializeStone, StoneValidationError, validateStone, type StoneNote } from '../src/vault/stone-schema.js';

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

  it('accepts only well-formed persisted lifecycle history', () => {
    const valid = validNote();
    valid.frontmatter.history = [{ type: 'canonized', at: '2026-10-29T00:00:00.000Z' }];
    expect(() => validateStone(valid)).not.toThrow();
    valid.frontmatter.history = [{ type: 'invented' as never, at: '2026-10-29T00:00:00.000Z' }];
    expect(() => validateStone(valid)).toThrow(/history/);
  });

  it('normalizes unquoted YAML timestamps to UTC ISO strings without changing string timestamps', () => {
    const lore = parseNote(`---
id: lo_a1b2c3
type: lore
title: Kevin lore
status: unconfirmed
created: 2026-10-31T12:00:00.000Z
author: Viewer
---
Related: [[st_k3f9a2]]
`);
    if (lore.frontmatter.type !== 'lore') throw new Error('expected lore note');
    expect(typeof lore.frontmatter.created).toBe('string');
    expect(lore.frontmatter.created).toBe('2026-10-31T12:00:00.000Z');
    expect(parseStone(serializeStone(validNote())).frontmatter.created).toBe(validNote().frontmatter.created);
  });

  it('normalizes persisted lifecycle timestamps before graph and index consumers see them', () => {
    const parsed = parseStone(`---
id: st_k3f9a2
type: stone
title: Kevin
status: canon
created: 2026-10-28T18:42:10.000Z
author: Viewer
source:
  - msg_id: message-1
    ts: 2026-10-28T18:42:08.000Z
history:
  - type: canonized
    at: 2026-10-29T00:00:00.000Z
---
Kevin is the boss.
`);
    expect(parsed.frontmatter.history?.[0]?.at).toBe('2026-10-29T00:00:00.000Z');
  });
});
