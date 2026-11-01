import path from 'node:path';
import type { NormalizedChatMessage } from './types.js';
import { SqliteIndex } from '../index/sqlite-index.js';
import { LOOP_ID_PATTERN, type StoneSource } from '../vault/stone-schema.js';
import { LoopNoteRepository } from '../vault/loop-repository.js';
import { StoneVaultWriter } from '../vault/writer.js';

export interface LoopServiceOptions {
  vaultPath: string;
  loops?: LoopNoteRepository;
  writer?: StoneVaultWriter;
  index?: SqliteIndex;
  log?: (message: string) => void;
}

/** Applies trusted chat events to the existing Loop Markdown repository. */
export class LoopService {
  private readonly writer: StoneVaultWriter;
  private readonly loops: LoopNoteRepository;

  constructor(private readonly options: LoopServiceOptions) {
    this.writer = options.writer ?? new StoneVaultWriter(options.vaultPath);
    this.loops = options.loops ?? new LoopNoteRepository(this.writer);
  }

  public async promise(message: NormalizedChatMessage, rawText: string, authorized: boolean): Promise<string> {
    if (!authorized) return 'Only moderators or the broadcaster can use that command.';
    const title = rawText.trim();
    if (!title) return 'Usage: !promise <text>';
    if (Array.from(title).length > 280) return 'Promise text must be 280 characters or fewer.';
    const created = validIso(message.timestamp) ? message.timestamp.toISOString() : new Date().toISOString();
    const source = validSource(message);
    try {
      const createdLoop = await this.loops.create({ title, owner: message.displayName, created, source });
      this.options.index?.upsert(createdLoop.note, createdLoop.receipt.relativePath);
      return `Promise recorded: ${createdLoop.note.frontmatter.id} (open).`;
    } catch {
      this.options.log?.('Loop creation failed after command validation.');
      return "Couldn't record that promise. Please try again.";
    }
  }

  public async done(message: NormalizedChatMessage, rawId: string, authorized: boolean): Promise<string> {
    if (!authorized) return 'Only moderators or the broadcaster can use that command.';
    const id = rawId.trim();
    if (!LOOP_ID_PATTERN.test(id)) return 'Invalid loop ID.';
    try {
      const note = await this.loops.complete(id, validIso(message.timestamp) ? message.timestamp.toISOString() : new Date().toISOString(), message.displayName);
      const found = await this.loops.find(id);
      if (!found) throw new Error('completed loop could not be re-read');
      this.options.index?.upsert(note, path.relative(this.options.vaultPath, found.filePath));
      return `Loop ${id} is completed.`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      if (detail.includes('already done')) return `Loop ${id} is already completed.`;
      if (detail.includes('Unknown loop ID')) return `Unknown loop ID: ${id}.`;
      this.options.log?.(`Loop completion failed for ${id}.`);
      return "Couldn't complete that loop. Please try again.";
    }
  }
}

function validIso(date: Date): boolean { return !Number.isNaN(date.getTime()); }

function validSource(message: NormalizedChatMessage): StoneSource[] | undefined {
  const id = message.id?.trim();
  if (!id || !validIso(message.timestamp)) return undefined;
  return [{ msg_id: id, ts: message.timestamp.toISOString(), author: message.displayName }];
}
