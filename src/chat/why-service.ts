import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SqliteIndex, type IndexedNote } from '../index/sqlite-index.js';
import { parseStone, type StoneNote } from '../vault/stone-schema.js';

const NOT_IN_VAULT = 'Not in the vault yet.';

export interface WhyServiceOptions {
  vaultPath: string;
  index: SqliteIndex;
  log?: (message: string) => void;
}

interface Evidence {
  indexed: IndexedNote;
  note: StoneNote;
}

export class WhyService {
  constructor(private readonly options: WhyServiceOptions) {}

  public async answer(topic: string): Promise<string> {
    const query = topic.trim();
    if (!query) return 'Usage: !why <topic>';

    let candidates: IndexedNote[];
    try {
      candidates = this.options.index.search(query, 8);
    } catch {
      this.options.log?.('SQLite search failed for !why; run npm run reindex.');
      return 'The vault index needs rebuilding. Run npm run reindex.';
    }

    const evidence: Evidence[] = [];
    for (const indexed of candidates) {
      if (indexed.status === 'superseded') continue;
      try {
        const note = parseStone(await fs.readFile(this.safeNotePath(indexed.relativePath), 'utf8'));
        if (note.frontmatter.id !== indexed.id) {
          throw new Error('front matter ID does not match the index');
        }
        if (note.frontmatter.status === 'superseded') continue;
        evidence.push({ indexed, note });
      } catch {
        this.options.log?.(`Skipped invalid or missing evidence for note ${indexed.id}.`);
      }
    }

    if (evidence.length === 0) return NOT_IN_VAULT;

    evidence.sort((left, right) => {
      const statusDifference = statusRank(left.note.frontmatter.status) - statusRank(right.note.frontmatter.status);
      if (statusDifference !== 0) return statusDifference;
      return (left.indexed.rank ?? 0) - (right.indexed.rank ?? 0);
    });

    const selected = evidence.slice(0, 3);
    const conflicting = new Set(selected.map(({ note }) => normalizeForComparison(note.body))).size > 1;
    if (conflicting && selected.length > 1) {
      return `The vault contains conflicting evidence. Sources: ${selected.map(formatCitation).join(', ')}.`;
    }

    const primary = selected[0];
    const label = primary.note.frontmatter.status === 'unconfirmed' ? 'Unconfirmed: ' : '';
    const citations = selected.map(formatCitation).join(', ');
    return `${label}${summarize(primary.note.body)} Sources: ${citations}.`;
  }

  private safeNotePath(relativePath: string): string {
    const root = path.resolve(this.options.vaultPath);
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('indexed path leaves the vault');
    }
    return candidate;
  }
}

function statusRank(status: StoneNote['frontmatter']['status']): number {
  if (status === 'canon') return 0;
  if (status === 'unconfirmed') return 1;
  return 2;
}

function summarize(body: string): string {
  const compact = body.replace(/\s+/gu, ' ').trim();
  const sentence = compact.match(/^.{1,220}?(?:[.!?](?:\s|$)|$)/u)?.[0]?.trim() ?? compact.slice(0, 220);
  return sentence.length < compact.length ? `${sentence}…` : sentence;
}

function normalizeForComparison(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function formatCitation(evidence: Evidence): string {
  return `${evidence.note.frontmatter.id} (${evidence.note.frontmatter.status})`;
}
