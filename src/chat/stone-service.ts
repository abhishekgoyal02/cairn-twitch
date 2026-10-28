import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { NormalizedChatMessage } from './types.js';
import { makeStoneTitle } from '../vault/filename.js';
import { SqliteIndex } from '../index/sqlite-index.js';
import { StoneVaultWriter } from '../vault/writer.js';
import type { StoneNote, StoneSource } from '../vault/stone-schema.js';

export interface StoneServiceOptions {
  vaultPath: string;
  writer?: StoneVaultWriter;
  index?: SqliteIndex;
  now?: () => number;
  idFactory?: () => string;
  log?: (message: string) => void;
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
      },
      body: text,
    };

    let finalPath: string;
    try {
      finalPath = await this.writer.writeStone(note);
    } catch {
      return "Couldn't save that stone. Please try again.";
    }

    this.cooldowns.set(viewerKey, current + 30_000);
    try {
      this.index.upsert(note, path.relative(this.options.vaultPath, finalPath));
    } catch {
      this.options.log?.(`Stone ${id} saved; SQLite index update failed and needs reindex.`);
      return `Stone saved: ${id} (index pending).`;
    }

    return `Stone saved: ${id} (unconfirmed).`;
  }

  public close(): void {
    this.index.close();
  }
}
