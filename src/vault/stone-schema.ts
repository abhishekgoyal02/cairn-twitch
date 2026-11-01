import matter from 'gray-matter';

export const STONE_ID_PATTERN = /^st_[A-Za-z0-9]{6}$/;
export const LORE_ID_PATTERN = /^lo_[A-Za-z0-9]{6}$/;
export const PERSON_ID_PATTERN = /^pe_[a-f0-9]{64}$/;
export const LOOP_ID_PATTERN = /^lp_[A-Za-z0-9]{6}$/;
export const STREAM_ID_PATTERN = /^sr_[a-f0-9]{64}$/;
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
export type NoteHistoryKind = 'created' | 'links_updated' | 'canonized' | 'superseded' | 'corrected' | 'forgotten' | 'completed';
export interface NoteHistoryEvent {
  type: NoteHistoryKind;
  at: string;
  relatedNoteId?: string;
  /** Public actor display name for an action Cairn actually performed. */
  actor?: string;
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
  /** Trusted Twitch stream identifier, set only for stones recorded in an active session. */
  streamId?: string;
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
export interface PersonFrontmatter {
  id: string;
  type: 'person';
  displayName: string;
  stoneIds: string[];
}
export interface PersonNote { frontmatter: PersonFrontmatter; body: string; }

export type LoopStatus = 'open' | 'done';
export interface LoopFrontmatter {
  id: string;
  type: 'loop';
  title: string;
  status: LoopStatus;
  created: string;
  owner: string;
  source?: StoneSource[];
  history?: NoteHistoryEvent[];
}
export interface LoopNote { frontmatter: LoopFrontmatter; body: string; }
export type StreamStatus = 'active' | 'finalizing' | 'completed' | 'interrupted';
export interface StreamFrontmatter {
  id: string;
  type: 'stream';
  streamId: string;
  broadcasterId: string;
  status: StreamStatus;
  started: string;
  ended?: string;
  stoneIds: string[];
  openLoopIds: string[];
  recoveryObservedAt?: string;
}
export interface StreamNote { frontmatter: StreamFrontmatter; body: string; }
export type VaultNote = StoneNote | LoreNote | PersonNote | LoopNote | StreamNote;

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
    if (!['created', 'links_updated', 'canonized', 'superseded', 'corrected', 'forgotten', 'completed'].includes(entry.type ?? '')) {
      throw new StoneValidationError(`history[${index}].type is not supported`);
    }
    if (!isUtcIso(entry.at)) throw new StoneValidationError(`history[${index}].at must be a UTC ISO timestamp`);
    if (entry.relatedNoteId !== undefined && typeof entry.relatedNoteId !== 'string') {
      throw new StoneValidationError(`history[${index}].relatedNoteId is invalid`);
    }
    if (entry.actor !== undefined && (typeof entry.actor !== 'string' || !entry.actor.trim() || entry.actor.length > 100)) {
      throw new StoneValidationError(`history[${index}].actor is invalid`);
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
  if (frontmatter.streamId !== undefined && (typeof frontmatter.streamId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(frontmatter.streamId))) {
    throw new StoneValidationError('streamId is invalid');
  }
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

function validSource(source: unknown, label: string, timestampRequired: boolean): asserts source is StoneSource[] {
  if (!Array.isArray(source) || source.length === 0) throw new StoneValidationError(`${label} must contain at least one message`);
  source.forEach((entry, index) => {
    if (!entry || typeof entry.msg_id !== 'string' || !entry.msg_id.trim()) throw new StoneValidationError(`${label}[${index}].msg_id is required`);
    if (timestampRequired && index === 0 && !entry.ts) throw new StoneValidationError(`${label}[0].ts is required`);
    if (entry.ts !== undefined && !isUtcIso(entry.ts)) throw new StoneValidationError(`${label}[${index}].ts must be a UTC ISO timestamp`);
    if (entry.author !== undefined && (typeof entry.author !== 'string' || !entry.author.trim())) throw new StoneValidationError(`${label}[${index}].author is invalid`);
  });
}

export function validatePerson(note: PersonNote, validStoneIds?: Set<string>): void {
  const fm = note.frontmatter;
  if (!fm || fm.type !== 'person') throw new StoneValidationError('type must be person');
  if (!PERSON_ID_PATTERN.test(fm.id)) throw new StoneValidationError('person id must match pe_ followed by a SHA-256 hexadecimal digest');
  if (typeof fm.displayName !== 'string' || !fm.displayName.trim() || fm.displayName.trim().length > 100) throw new StoneValidationError('displayName is required and must be at most 100 characters');
  if (!Array.isArray(fm.stoneIds) || !fm.stoneIds.every((id) => typeof id === 'string' && STONE_ID_PATTERN.test(id))) throw new StoneValidationError('stoneIds must contain valid stone IDs');
  if (new Set(fm.stoneIds).size !== fm.stoneIds.length) throw new StoneValidationError('stoneIds must not contain duplicates');
  if (validStoneIds) for (const id of fm.stoneIds) if (!validStoneIds.has(id)) throw new StoneValidationError(`person contribution references missing stone ${id}`);
  const permitted = new Set(['id', 'type', 'displayName', 'stoneIds']);
  if (Object.keys(fm).some((key) => !permitted.has(key))) throw new StoneValidationError('person front matter may contain only public display name and stone references');
  const bodyIds = note.body.trim() ? note.body.split(/\r?\n/u).map((line) => {
    const match = /^\[\[(st_[A-Za-z0-9]{6})\]\]$/u.exec(line.trim());
    if (!match) throw new StoneValidationError('person body may contain only contributed stone wikilinks');
    return match[1];
  }) : [];
  if (new Set(bodyIds).size !== bodyIds.length || bodyIds.length !== fm.stoneIds.length || bodyIds.some((id, index) => id !== fm.stoneIds[index])) {
    throw new StoneValidationError('person body must exactly match stoneIds');
  }
}

export function validateLoop(note: LoopNote): void {
  const fm = note.frontmatter;
  if (!fm || fm.type !== 'loop') throw new StoneValidationError('type must be loop');
  if (!LOOP_ID_PATTERN.test(fm.id)) throw new StoneValidationError('loop id must match lp_ followed by six alphanumeric characters');
  if (!fm.title?.trim() || fm.title.trim().length > 280) throw new StoneValidationError('loop title is required and must be at most 280 characters');
  if (fm.status !== 'open' && fm.status !== 'done') throw new StoneValidationError('loop status must be open or done');
  if (!isUtcIso(fm.created)) throw new StoneValidationError('created must be a UTC ISO timestamp');
  if (!fm.owner?.trim() || fm.owner.trim().length > 100) throw new StoneValidationError('loop owner is required and must be at most 100 characters');
  if (fm.source !== undefined) validSource(fm.source, 'source', true);
  validateHistory(fm.history);
}

export function validateStream(note: StreamNote, validStoneIds?: Set<string>, validLoopIds?: Set<string>): void {
  const fm = note.frontmatter;
  if (!fm || fm.type !== 'stream') throw new StoneValidationError('type must be stream');
  if (!STREAM_ID_PATTERN.test(fm.id)) throw new StoneValidationError('stream note id is invalid');
  if (typeof fm.streamId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(fm.streamId)) throw new StoneValidationError('streamId is invalid');
  if (typeof fm.broadcasterId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(fm.broadcasterId)) throw new StoneValidationError('broadcasterId is invalid');
  if (!['active', 'finalizing', 'completed', 'interrupted'].includes(fm.status)) throw new StoneValidationError('stream status is invalid');
  if (!isUtcIso(fm.started)) throw new StoneValidationError('stream started must be a UTC ISO timestamp');
  if (fm.ended !== undefined && (!isUtcIso(fm.ended) || Date.parse(fm.ended) < Date.parse(fm.started))) throw new StoneValidationError('stream ended is invalid');
  if (fm.recoveryObservedAt !== undefined && !isUtcIso(fm.recoveryObservedAt)) throw new StoneValidationError('stream recoveryObservedAt is invalid');
  if (!Array.isArray(fm.stoneIds) || !fm.stoneIds.every((id) => STONE_ID_PATTERN.test(id)) || new Set(fm.stoneIds).size !== fm.stoneIds.length) throw new StoneValidationError('stream stoneIds are invalid');
  if (!Array.isArray(fm.openLoopIds) || !fm.openLoopIds.every((id) => LOOP_ID_PATTERN.test(id)) || new Set(fm.openLoopIds).size !== fm.openLoopIds.length) throw new StoneValidationError('stream openLoopIds are invalid');
  if (validStoneIds) for (const id of fm.stoneIds) if (!validStoneIds.has(id)) throw new StoneValidationError(`stream references missing stone ${id}`);
  if (validLoopIds) for (const id of fm.openLoopIds) if (!validLoopIds.has(id)) throw new StoneValidationError(`stream references missing loop ${id}`);
  const expected = streamBody(fm.stoneIds, fm.openLoopIds);
  if (note.body.trim() !== expected) throw new StoneValidationError('stream body must match recorded references');
}

export function streamBody(stoneIds: string[], loopIds: string[]): string {
  const stones = stoneIds.length ? stoneIds.map((id) => `- [[${id}]]`).join('\n') : '- None recorded.';
  const loops = loopIds.length ? loopIds.map((id) => `- [[${id}]]`).join('\n') : '- None open at stream end.';
  return `## Stones added\n${stones}\n\n## Open loops at stream end\n${loops}`;
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
  if (parsed.data?.type === 'person') {
    const note: PersonNote = { frontmatter: { ...parsed.data } as PersonFrontmatter, body: parsed.content.trim() };
    validatePerson(note);
    return note;
  }
  if (parsed.data?.type === 'loop') {
    const note: LoopNote = {
      frontmatter: { ...parsed.data, created: normalizeTimestamp(parsed.data.created), history: normalizeHistory(parsed.data.history) } as LoopFrontmatter,
      body: parsed.content.trim(),
    };
    validateLoop(note);
    return note;
  }
  if (parsed.data?.type === 'stream') {
    const note: StreamNote = { frontmatter: { ...parsed.data, started: normalizeTimestamp(parsed.data.started), ended: normalizeTimestamp(parsed.data.ended), recoveryObservedAt: normalizeTimestamp(parsed.data.recoveryObservedAt) } as StreamFrontmatter, body: parsed.content.trim() };
    validateStream(note);
    return note;
  }
  return parseStone(markdown);
}

export function serializeNote(note: VaultNote): string {
  if (note.frontmatter.type === 'lore') validateLore(note as LoreNote);
  else if (note.frontmatter.type === 'person') validatePerson(note as PersonNote);
  else if (note.frontmatter.type === 'loop') validateLoop(note as LoopNote);
  else if (note.frontmatter.type === 'stream') validateStream(note as StreamNote);
  else validateStone(note as StoneNote);
  return matter.stringify(note.body, withoutUndefined(note.frontmatter));
}

function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutUndefined(item)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)])) as T;
  }
  return value;
}
