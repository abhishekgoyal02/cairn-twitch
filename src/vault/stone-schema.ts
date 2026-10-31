import matter from 'gray-matter';

export const STONE_ID_PATTERN = /^st_[A-Za-z0-9]{6}$/;
export const LORE_ID_PATTERN = /^lo_[A-Za-z0-9]{6}$/;
export const STONE_STATUSES = ['unconfirmed', 'canon', 'superseded'] as const;
export type StoneStatus = (typeof STONE_STATUSES)[number];

export interface StoneSource {
  msg_id: string;
  ts?: string;
  author?: string;
}

/**
 * Cairn-managed, append-only lifecycle evidence.  It deliberately records
 * only actions Cairn actually performed; manual Obsidian edits have no
 * invented history entry.
 */
export type NoteHistoryKind = 'created' | 'links_updated' | 'canonized' | 'superseded' | 'corrected' | 'forgotten';
export interface NoteHistoryEvent {
  type: NoteHistoryKind;
  at: string;
  relatedNoteId?: string;
}

export interface StoneFrontmatter {
  id: string;
  type: 'stone';
  title: string;
  status: StoneStatus;
  created: string;
  author: string;
  source: StoneSource[];
  supersedes?: string;
  history?: NoteHistoryEvent[];
}

export interface StoneNote {
  frontmatter: StoneFrontmatter;
  body: string;
}
export interface LoreFrontmatter {
  id: string; type: 'lore'; title: string; status: StoneStatus; created: string; author: string;
  history?: NoteHistoryEvent[];
}
export interface LoreNote { frontmatter: LoreFrontmatter; body: string; }
export type VaultNote = StoneNote | LoreNote;

export class StoneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoneValidationError';
  }
}

function isUtcIso(value: unknown): value is string {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return (
    typeof value === 'string' &&
    /T/.test(value) &&
    /Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** gray-matter/YAML may materialize unquoted ISO timestamps as Date objects.
 * Normalize them at the parsing boundary so graph and SQLite consumers only
 * receive primitive UTC ISO strings, without rewriting the Markdown source. */
function normalizeTimestamp(value: unknown): string | unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeHistory(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((event) => event && typeof event === 'object'
    ? { ...(event as Record<string, unknown>), at: normalizeTimestamp((event as Record<string, unknown>).at) }
    : event);
}

function validateHistory(history: unknown): void {
  if (history === undefined) return;
  if (!Array.isArray(history)) throw new StoneValidationError('history must be an array');
  for (const [index, event] of history.entries()) {
    if (!event || typeof event !== 'object') throw new StoneValidationError(`history[${index}] is invalid`);
    const entry = event as Partial<NoteHistoryEvent>;
    if (!['created', 'links_updated', 'canonized', 'superseded', 'corrected', 'forgotten'].includes(entry.type ?? '')) {
      throw new StoneValidationError(`history[${index}].type is not supported`);
    }
    if (!isUtcIso(entry.at)) throw new StoneValidationError(`history[${index}].at must be a UTC ISO timestamp`);
    if (entry.relatedNoteId !== undefined && typeof entry.relatedNoteId !== 'string') {
      throw new StoneValidationError(`history[${index}].relatedNoteId is invalid`);
    }
  }
}

export function validateStone(note: StoneNote): void {
  const frontmatter = note.frontmatter;
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new StoneValidationError('front matter is missing');
  }
  if (typeof frontmatter.id !== 'string' || !STONE_ID_PATTERN.test(frontmatter.id)) {
    throw new StoneValidationError('id must match st_ followed by six alphanumeric characters');
  }
  if (frontmatter.type !== 'stone') throw new StoneValidationError('type must be stone');
  if (!STONE_STATUSES.includes(frontmatter.status)) {
    throw new StoneValidationError('status is not supported');
  }
  if (!frontmatter.title?.trim()) throw new StoneValidationError('title is required');
  if (!isUtcIso(frontmatter.created)) throw new StoneValidationError('created must be a UTC ISO timestamp');
  if (!frontmatter.author?.trim()) throw new StoneValidationError('author is required');
  if (!Array.isArray(frontmatter.source) || frontmatter.source.length === 0) {
    throw new StoneValidationError('source must contain at least one message');
  }

  frontmatter.source.forEach((source, index) => {
    if (!source || typeof source.msg_id !== 'string' || !source.msg_id.trim()) {
      throw new StoneValidationError(`source[${index}].msg_id is required`);
    }
    if (index === 0 && !source.ts) {
      throw new StoneValidationError('source[0].ts is required');
    }
    if (source.ts !== undefined && !isUtcIso(source.ts)) {
      throw new StoneValidationError(`source[${index}].ts must be a UTC ISO timestamp`);
    }
  });

  if (!note.body?.trim()) throw new StoneValidationError('body is required');
  validateHistory(frontmatter.history);
}

export function serializeStone(note: StoneNote): string {
  validateStone(note);
  return matter.stringify(note.body, note.frontmatter);
}

export function parseStone(markdown: string): StoneNote {
  const parsed = matter(markdown);
  const note: StoneNote = {
    frontmatter: { ...parsed.data, created: normalizeTimestamp(parsed.data.created), history: normalizeHistory(parsed.data.history) } as StoneFrontmatter,
    body: parsed.content.trim(),
  };
  validateStone(note);
  return note;
}

export function validateLore(note: LoreNote, validStoneIds?: Set<string>): void {
  const fm = note.frontmatter;
  if (!fm || fm.type !== 'lore') throw new StoneValidationError('type must be lore');
  if (!LORE_ID_PATTERN.test(fm.id)) throw new StoneValidationError('lore id must match lo_ followed by six alphanumeric characters');
  if (!STONE_STATUSES.includes(fm.status)) throw new StoneValidationError('status is not supported');
  if (!fm.title?.trim()) throw new StoneValidationError('title is required');
  if (!isUtcIso(fm.created)) throw new StoneValidationError('created must be a UTC ISO timestamp');
  if (!fm.author?.trim()) throw new StoneValidationError('author is required');
  if (!note.body?.trim()) throw new StoneValidationError('body is required');
  validateHistory(fm.history);
  const ids = [...note.body.matchAll(/\[\[(st_[A-Za-z0-9]{6})\]\]/gu)].map((match) => match[1]);
  if (ids.length === 0) throw new StoneValidationError('lore note must link to at least one stone');
  if (validStoneIds) for (const id of ids) if (!validStoneIds.has(id)) throw new StoneValidationError(`lore relationship references missing stone ${id}`);
}

export function parseNote(markdown: string): VaultNote {
  const parsed = matter(markdown);
  if (parsed.data?.type === 'lore') {
    const note: LoreNote = {
      frontmatter: { ...parsed.data, created: normalizeTimestamp(parsed.data.created), history: normalizeHistory(parsed.data.history) } as LoreFrontmatter,
      body: parsed.content.trim(),
    };
    validateLore(note);
    return note;
  }
  return parseStone(markdown);
}

export function serializeNote(note: VaultNote): string {
  if (note.frontmatter.type === 'lore') validateLore(note as LoreNote);
  else validateStone(note as StoneNote);
  return matter.stringify(note.body, note.frontmatter);
}
