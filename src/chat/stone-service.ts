import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { NormalizedChatMessage } from './types.js';
import { makeStoneTitle } from '../vault/filename.js';
import { SqliteIndex, type IndexedNote } from '../index/sqlite-index.js';
import { StoneVaultWriter } from '../vault/writer.js';
import type { StoneNote, StoneSource, LoreNote } from '../vault/stone-schema.js';
import type { LlmAdapter } from '../intelligence/llm.js';

export interface StoneServiceOptions {
  vaultPath: string;
  writer?: StoneVaultWriter;
  index?: SqliteIndex;
  now?: () => number;
  idFactory?: () => string;
  log?: (message: string) => void;
  llm?: LlmAdapter;
}

export class StoneService {
  private readonly writer: StoneVaultWriter;
  private readonly index: SqliteIndex;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly options: StoneServiceOptions) {
    this.writer = options.writer ?? new StoneVaultWriter(options.vaultPath);
    this.index = options.index ?? new SqliteIndex(
      path.join(options.vaultPath, '.cairn', 'index.sqlite'),
      options.vaultPath,
    );
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `st_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/gu, '').slice(0, 6).padEnd(6, '0')}`);
  }

  public async create(message: NormalizedChatMessage, body: string): Promise<string> {
    const text = body.trim();
    if (!text) return 'Usage: !stone <text>';
    if (Array.from(text).length > 280) return 'Stone text must be 280 characters or fewer.';

    const viewerKey = (message.senderId ?? message.sender).toLowerCase();
    const current = this.now();
    for (const [key, expiresAt] of this.cooldowns) {
      if (expiresAt <= current) this.cooldowns.delete(key);
    }
    const cooldownUntil = this.cooldowns.get(viewerKey) ?? 0;
    if (current < cooldownUntil) return 'You can add another stone in a little while.';

    const created = new Date(current).toISOString();
    let id = this.idFactory();
    while (await this.writer.hasStoneId(id)) id = this.idFactory();

    const sources: StoneSource[] = [
      {
        msg_id: message.id,
        ts: message.timestamp.toISOString(),
        author: message.displayName,
      },
    ];
    if (message.replyToMessageId) {
      const parentSource: { msg_id: string; author?: string } = {
        msg_id: message.replyToMessageId,
      };
      if (message.replyToDisplayName) parentSource.author = message.replyToDisplayName;
      sources.push(parentSource);
    }

    const note: StoneNote = {
      frontmatter: {
        id,
        type: 'stone',
        title: makeStoneTitle(text),
        status: 'unconfirmed',
        created,
        author: message.displayName,
        source: sources,
        history: [{ type: 'created', at: created }],
      },
      body: text,
    };

    let receipt;
    try {
      receipt = await this.writer.writeStone(note);
      this.options.log?.(`Stone persistence verified: id=${receipt.noteId} path=${receipt.relativePath} outcome=durable.`);
    } catch {
      return "Couldn't save that stone. Please try again.";
    }

    this.cooldowns.set(viewerKey, current + 30_000);
    try {
      this.index.upsert(note, receipt.relativePath);
    } catch {
      this.options.log?.(`Stone ${id} saved; SQLite index update failed and needs reindex.`);
      return `Stone saved: ${id} (index pending).`;
    }

    // Relationship suggestions are deliberately asynchronous: persistence and graph visibility never wait for a provider.
    let candidates: IndexedNote[] = [];
    const candidateSearchStartedAt = Date.now();
    try {
      candidates = this.index.search(note.body, 8).filter((candidate) => candidate.id !== note.frontmatter.id);
      this.options.log?.(`Stone relationship candidates: count=${candidates.length} elapsed_ms=${Date.now() - candidateSearchStartedAt}.`);
    } catch {
      this.options.log?.(`Stone ${id} persisted; candidate retrieval failed elapsed_ms=${Date.now() - candidateSearchStartedAt}.`);
    }
    if (this.options.llm) void this.suggestRelationships(note, receipt.absolutePath, candidates);

    return `Stone saved: ${id} (unconfirmed).`;
  }

  private async createLoreForStone(stone: StoneNote, title?: string): Promise<void> {
    try {
      let id = `lo_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/gu, '').slice(0, 6).padEnd(6, '0')}`;
      while (await this.writer.hasStoneId(id)) id = `lo_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/gu, '').slice(0, 6).padEnd(6, '0')}`;
      const lore: LoreNote = {
        frontmatter: { id, type: 'lore', title: title?.trim() || stone.frontmatter.title, status: 'unconfirmed', created: stone.frontmatter.created, author: stone.frontmatter.author, history: [{ type: 'created', at: stone.frontmatter.created }] },
        body: `Related: [[${stone.frontmatter.id}]]`,
      };
      const receipt = await this.writer.writeLore(lore);
      this.index.upsert(lore, receipt.relativePath);
    } catch { this.options.log?.(`Lore creation failed for ${stone.frontmatter.id}; stone remains saved.`); }
  }

  private async suggestRelationships(note: StoneNote, filePath: string, indexedCandidates = this.index.search(note.body, 8).filter((candidate) => candidate.id !== note.frontmatter.id)): Promise<void> {
    try {
      const candidates = indexedCandidates
        .map((candidate) => ({ id: candidate.id, title: candidate.title, body: candidate.body }));
      if (candidates.length === 0) {
        // Lore discovery is deliberately independent of link candidates: the newly
        // persisted stone is the only allowed evidence in this no-match case.
        const lore = this.options.llm!.suggestLore
          ? await this.options.llm!.suggestLore({ stoneText: note.body, stoneIds: [note.frontmatter.id] })
          : undefined;
        if (lore?.stoneIds.includes(note.frontmatter.id)) await this.createLoreForStone(note, lore.title);
        return;
      }
      const suggestion = await this.options.llm!.suggestLinks({ stoneText: note.body, candidates });
      const selected = candidates.filter((candidate) => suggestion.ids.includes(candidate.id));
      if (selected.length === 0) {
        // Links are ID-only. Request a lore title only after no candidate survived
        // local validation, keeping the normal relationship response compact.
        const lore = this.options.llm!.suggestLore
          ? await this.options.llm!.suggestLore({ stoneText: note.body, stoneIds: [note.frontmatter.id] })
          : undefined;
        if (lore?.stoneIds.includes(note.frontmatter.id)) await this.createLoreForStone(note, lore.title);
        return;
      }
      const existing = new Set<string>();
      for (const match of note.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)) existing.add(match[1].trim().toLowerCase());
      const additions = selected.filter((candidate) => !existing.has(candidate.title.toLowerCase())).map((candidate) => `[[${candidate.title}]]`);
      if (additions.length === 0) return;
      const updated: StoneNote = { ...note, frontmatter: { ...note.frontmatter, history: [...(note.frontmatter.history ?? []), { type: 'links_updated', at: new Date().toISOString() }] }, body: `${note.body.trim()}\n\nRelated: ${additions.join(' ')}` };
      await this.writer.updateStone(filePath, updated);
      this.index.upsert(updated, path.relative(this.options.vaultPath, filePath));
    } catch {
      this.options.log?.(`Relationship suggestion failed for ${note.frontmatter.id}; stone remains saved.`);
    }
  }

  public close(): void {
    this.index.close();
  }
}
