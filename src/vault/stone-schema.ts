import matter from 'gray-matter';

export const STONE_ID_PATTERN = /^st_[A-Za-z0-9]{6}$/;
export const STONE_STATUSES = ['unconfirmed', 'canon', 'superseded'] as const;
export type StoneStatus = (typeof STONE_STATUSES)[number];

export interface StoneSource {
  msg_id: string;
  ts?: string;
  author?: string;
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
}

export interface StoneNote {
  frontmatter: StoneFrontmatter;
  body: string;
}

export class StoneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoneValidationError';
  }
}

function isUtcIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /T/.test(value) &&
    /Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
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
}

export function serializeStone(note: StoneNote): string {
  validateStone(note);
  return matter.stringify(note.body, note.frontmatter);
}

export function parseStone(markdown: string): StoneNote {
  const parsed = matter(markdown);
  const note: StoneNote = {
    frontmatter: parsed.data as StoneFrontmatter,
    body: parsed.content.trim(),
  };
  validateStone(note);
  return note;
}
