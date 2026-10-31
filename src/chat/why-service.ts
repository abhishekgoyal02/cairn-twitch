import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SqliteIndex, type IndexedNote } from '../index/sqlite-index.js';
import { parseStone, type StoneNote } from '../vault/stone-schema.js';
import type { LoreCardModel } from '../overlay/types.js';
import type { LlmAdapter } from '../intelligence/llm.js';

const NOT_IN_VAULT = 'Not in the vault yet.';

export interface WhyServiceOptions {
  vaultPath: string;
  index: SqliteIndex;
  log?: (message: string) => void;
  onCard?: (card: LoreCardModel) => void;
  llm?: LlmAdapter;
}

interface Evidence {
  indexed: IndexedNote;
  note: StoneNote;
}

export class WhyService {
  constructor(private readonly options: WhyServiceOptions) {}

  public async answer(topic: string): Promise<string> {
    return (await this.answerWithCard(topic)).text;
  }

  public async answerWithCard(topic: string): Promise<{ text: string; card?: LoreCardModel }> {
    const query = topic.trim();
    if (!query) return { text: 'Usage: !why <topic>' };

    let candidates: IndexedNote[];
    try {
      candidates = this.options.index.search(query, 8);
    } catch {
      this.options.log?.('SQLite search failed for !why; run npm run reindex.');
      return { text: 'The vault index needs rebuilding. Run npm run reindex.' };
    }

    const queryTokens = meaningfulTokens(query);
    if (queryTokens.length === 0) return { text: NOT_IN_VAULT };
    const evidence: Evidence[] = [];
    for (const indexed of candidates) {
      if (indexed.status === 'superseded') continue;
      try {
        const note = parseStone(await fs.readFile(this.safeNotePath(indexed.relativePath), 'utf8'));
        if (note.frontmatter.id !== indexed.id) {
          throw new Error('front matter ID does not match the index');
        }
        if (note.frontmatter.status === 'superseded') continue;
        if (isRelevant(query, note, queryTokens)) evidence.push({ indexed, note });
      } catch {
        this.options.log?.(`Skipped invalid or missing evidence for note ${indexed.id}.`);
      }
    }

    if (evidence.length === 0) return { text: NOT_IN_VAULT };

    evidence.sort((left, right) => {
      const statusDifference = statusRank(left.note.frontmatter.status) - statusRank(right.note.frontmatter.status);
      if (statusDifference !== 0) return statusDifference;
      return (left.indexed.rank ?? 0) - (right.indexed.rank ?? 0);
    });

    const selected = evidence.slice(0, 3);
    if (this.options.llm) {
      const model = await this.options.llm.answerWhy({
        question: query,
        notes: selected.map(({ note }) => ({ id: note.frontmatter.id, title: note.frontmatter.title, body: note.body })),
      });
      const validCitations = model.citations.filter((id) => selected.some(({ note }) => note.frontmatter.id === id));
      if (model.answer && validCitations.length > 0) {
        const text = `${model.answer} Sources: ${validCitations.join(', ')}.`.slice(0, 499);
        const primary = selected.find(({ note }) => validCitations.includes(note.frontmatter.id)) ?? selected[0];
        const card: LoreCardModel = { topic: query, answer: text, title: primary.note.frontmatter.title, noteId: primary.note.frontmatter.id, status: primary.note.frontmatter.status };
        this.options.onCard?.(card);
        return { text, card };
      }
    }
    const conflicting = containsContradiction(selected.map(({ note }) => note.body), queryTokens);
    if (conflicting && selected.length > 1) {
      return { text: `The vault contains conflicting evidence. Sources: ${selected.map(formatCitation).join(', ')}.` };
    }

    const primary = selected[0];
    const label = primary.note.frontmatter.status === 'unconfirmed' ? 'Unconfirmed: ' : '';
    const citations = selected.map(formatCitation).join(', ');
    const text = `${label}${summarize(primary.note.body)} Sources: ${citations}.`;
    const card: LoreCardModel = {
      topic: query,
      answer: text,
      title: primary.note.frontmatter.title,
      noteId: primary.note.frontmatter.id,
      status: primary.note.frontmatter.status,
    };
    this.options.onCard?.(card);
    return { text, card };
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

const STOP_WORDS = new Set('a an and are as at be by for from how in is it of on or that the their this to was what when where with why after before about into'.split(' '));

function meaningfulTokens(value: string): string[] {
  return [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
}

function isRelevant(query: string, note: StoneNote, queryTokens: string[]): boolean {
  const title = normalizeForComparison(note.frontmatter.title);
  const body = normalizeForComparison(note.body);
  const haystack = `${title} ${body}`;
  const haystackTokens = new Set(haystack.match(/[\p{L}\p{N}]+/gu) ?? []);
  const matched = queryTokens.filter((token) => haystackTokens.has(token));
  if (matched.length === 0) return false;
  const phrase = normalizeForComparison(query).split(/\s+/u).filter((token) => token && !STOP_WORDS.has(token)).join(' ');
  const phraseMatch = phrase.length > 0 && haystack.includes(phrase);
  if (queryTokens.length === 1) return true;
  return phraseMatch || matched.length >= Math.min(2, queryTokens.length);
}

function containsContradiction(bodies: string[], queryTokens: string[]): boolean {
  for (let left = 0; left < bodies.length; left += 1) for (let right = left + 1; right < bodies.length; right += 1) {
    const a = normalizeForComparison(bodies[left]); const b = normalizeForComparison(bodies[right]);
    const shared = queryTokens.filter((token) => a.includes(token) && b.includes(token)).length;
    if (shared === 0) continue;
    const aNegative = /\b(?:not|never|no longer|wrong|false|isn't|wasn't)\b/iu.test(a);
    const bNegative = /\b(?:not|never|no longer|wrong|false|isn't|wasn't)\b/iu.test(b);
    if (aNegative !== bNegative) return true;
  }
  return false;
}

function formatCitation(evidence: Evidence): string {
  return `${evidence.note.frontmatter.id} (${evidence.note.frontmatter.status})`;
}
