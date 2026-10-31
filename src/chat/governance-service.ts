import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { NormalizedChatMessage } from './types.js';
import { makeStoneTitle } from '../vault/filename.js';
import { StoneVaultWriter } from '../vault/writer.js';
import { validateStone, type NoteHistoryEvent, type StoneNote } from '../vault/stone-schema.js';
import { SqliteIndex } from '../index/sqlite-index.js';

export interface GovernanceServiceOptions {
  vaultPath: string;
  writer?: StoneVaultWriter;
  index?: SqliteIndex;
  idFactory?: () => string;
  log?: (message: string) => void;
}

export class GovernanceService {
  private readonly writer: StoneVaultWriter;
  private readonly index?: SqliteIndex;
  private readonly idFactory: () => string;

  constructor(private readonly options: GovernanceServiceOptions) {
    this.writer = options.writer ?? new StoneVaultWriter(options.vaultPath);
    this.index = options.index;
    this.idFactory = options.idFactory ?? (() => `st_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/gu, '').slice(0, 6).padEnd(6, '0')}`);
  }

  public async canon(id: string, authorized: boolean): Promise<string> {
    if (!authorized) return 'Only moderators or the broadcaster can use that command.';
    const found = await this.writer.findStone(id.trim());
    if (!found) return `Unknown stone ID: ${id.trim() || '(missing)'}.`;
    if (found.note.frontmatter.status === 'canon') return `${id} is already canon.`;
    found.note.frontmatter.status = 'canon';
    appendHistory(found.note, { type: 'canonized', at: new Date().toISOString() });
    await this.writer.updateStone(found.filePath, found.note);
    this.index?.upsert(found.note, path.relative(this.options.vaultPath, found.filePath));
    return `Stone ${found.note.frontmatter.id} is now canon.`;
  }

  public async correct(id: string, text: string, message: NormalizedChatMessage, authorized: boolean): Promise<string> {
    if (!authorized) return 'Only moderators or the broadcaster can use that command.';
    const body = text.trim();
    if (!body) return 'Usage: !correct <id> <new text>';
    if (Array.from(body).length > 280) return 'Correction text must be 280 characters or fewer.';
    const found = await this.writer.findStone(id.trim());
    if (!found) return `Unknown stone ID: ${id.trim() || '(missing)'}.`;
    if (found.note.frontmatter.status === 'superseded') return `Stone ${found.note.frontmatter.id} is already superseded.`;

    let replacementId = this.idFactory();
    while (await this.writer.hasStoneId(replacementId)) replacementId = this.idFactory();
    const replacement: StoneNote = {
      frontmatter: {
        id: replacementId,
        type: 'stone',
        title: makeStoneTitle(body),
        status: 'unconfirmed',
        created: message.timestamp.toISOString(),
        author: message.displayName,
        source: [{ msg_id: message.id, ts: message.timestamp.toISOString(), author: message.displayName }],
        supersedes: found.note.frontmatter.id,
        history: [
          { type: 'created', at: message.timestamp.toISOString() },
          { type: 'corrected', at: message.timestamp.toISOString(), relatedNoteId: found.note.frontmatter.id },
        ],
      },
      body,
    };
    validateStone(replacement);
    const replacementReceipt = await this.writer.writeStone(replacement);
    try {
      found.note.frontmatter.status = 'superseded';
      appendHistory(found.note, { type: 'superseded', at: message.timestamp.toISOString(), relatedNoteId: replacementId });
      await this.writer.updateStone(found.filePath, found.note);
    } catch (error) {
      await fs.unlink(replacementReceipt.absolutePath).catch(() => undefined);
      throw error;
    }
    this.index?.upsert(replacement, replacementReceipt.relativePath);
    this.index?.upsert(found.note, path.relative(this.options.vaultPath, found.filePath));
    return `Correction saved as ${replacementId}; ${id} is superseded.`;
  }

  public async forget(id: string, authorized: boolean): Promise<string> {
    if (!authorized) return 'Only moderators or the broadcaster can use that command.';
    const found = await this.writer.findStone(id.trim());
    if (!found) {
      const trashed = await this.writer.findTrashedStone(id.trim());
      if (trashed) { this.index?.remove(trashed.note.frontmatter.id); return `Stone ${trashed.note.frontmatter.id} is already in trash.`; }
      return `Unknown stone ID: ${id.trim() || '(missing)'}.`;
    }
    appendHistory(found.note, { type: 'forgotten', at: new Date().toISOString() });
    // Persist the real forget event before moving the same Markdown file. If
    // this atomic rewrite fails, the active note remains untouched.
    await this.writer.updateStone(found.filePath, found.note);
    await this.writer.moveToTrash(found.filePath, found.note.frontmatter.id);
    this.index?.remove(found.note.frontmatter.id);
    return `Stone ${found.note.frontmatter.id} moved to trash.`;
  }
}

function appendHistory(note: StoneNote, event: NoteHistoryEvent): void {
  note.frontmatter.history = [...(note.frontmatter.history ?? []), event];
}
