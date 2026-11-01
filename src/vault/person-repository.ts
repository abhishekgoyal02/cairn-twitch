import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PERSON_ID_PATTERN, STONE_ID_PATTERN, parseNote, type PersonNote } from './stone-schema.js';
import { StoneVaultWriter, type PersistenceReceipt } from './writer.js';

/**
 * Person identity is derived from a trusted Twitch user ID, but the ID itself
 * is never written into Markdown. The full SHA-256 digest is stable and
 * filesystem-safe, with collision resistance appropriate for this mapping.
 */
export function personIdForTwitchIdentity(twitchUserId: string): string {
  const normalized = twitchUserId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) throw new Error('Invalid Twitch contributor identity');
  return `pe_${createHash('sha256').update(`cairn-person:${normalized}`, 'utf8').digest('hex')}`;
}

export interface PersonRecord { note: PersonNote; filePath: string; }

export class PersonNoteRepository {
  constructor(private readonly vaultPath: string, private readonly writer = new StoneVaultWriter(vaultPath)) {}

  public async find(twitchUserId: string): Promise<PersonRecord | undefined> {
    const id = personIdForTwitchIdentity(twitchUserId);
    const filePath = this.filePathForId(id);
    try {
      const note = parseNote(await fs.readFile(filePath, 'utf8'));
      if (note.frontmatter.type !== 'person' || note.frontmatter.id !== id) throw new Error('person note identity mismatch');
      return { note: note as PersonNote, filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  public async getOrCreate(twitchUserId: string, displayName: string): Promise<PersonRecord> {
    const existing = await this.find(twitchUserId);
    if (existing) {
      const normalizedName = normalizeDisplayName(displayName);
      if (existing.note.frontmatter.displayName !== normalizedName) {
        const updated: PersonNote = { ...existing.note, frontmatter: { ...existing.note.frontmatter, displayName: normalizedName } };
        await this.writer.updatePerson(existing.filePath, updated);
        return this.verify(twitchUserId, existing.filePath, updated);
      }
      return existing;
    }
    const id = personIdForTwitchIdentity(twitchUserId);
    const note: PersonNote = { frontmatter: { id, type: 'person', displayName: normalizeDisplayName(displayName), stoneIds: [] }, body: '' };
    const receipt = await this.writer.writePerson(note);
    return { note, filePath: receipt.absolutePath };
  }

  public async addContribution(twitchUserId: string, displayName: string, stoneId: string): Promise<PersonRecord> {
    if (!STONE_ID_PATTERN.test(stoneId)) throw new Error('Invalid contributed stone ID');
    if (!await this.writer.findStone(stoneId)) throw new Error(`Contributed stone does not exist: ${stoneId}`);
    const record = await this.getOrCreate(twitchUserId, displayName);
    if (record.note.frontmatter.stoneIds.includes(stoneId)) return record;
    const note: PersonNote = {
      ...record.note,
      frontmatter: { ...record.note.frontmatter, stoneIds: [...record.note.frontmatter.stoneIds, stoneId] },
      body: [...record.note.frontmatter.stoneIds, stoneId].map((id) => `[[${id}]]`).join('\n'),
    };
    await this.writer.updatePerson(record.filePath, note);
    return this.verify(twitchUserId, record.filePath, note);
  }

  public async contributedStoneIds(twitchUserId: string): Promise<string[]> {
    return (await this.find(twitchUserId))?.note.frontmatter.stoneIds.slice() ?? [];
  }

  public filePathForId(id: string): string {
    if (!PERSON_ID_PATTERN.test(id)) throw new Error('Invalid person note ID');
    const root = path.resolve(this.vaultPath, 'people');
    const candidate = path.resolve(root, `${id}.md`);
    if (path.dirname(candidate) !== root) throw new Error('Unsafe person note path');
    return candidate;
  }

  private async verify(twitchUserId: string, filePath: string, expected: PersonNote): Promise<PersonRecord> {
    const persisted = await this.find(twitchUserId);
    if (!persisted || persisted.filePath !== filePath
      || persisted.note.frontmatter.displayName !== expected.frontmatter.displayName
      || persisted.note.frontmatter.stoneIds.join('\u0000') !== expected.frontmatter.stoneIds.join('\u0000')) {
      throw new Error('person note persistence verification failed');
    }
    return persisted;
  }
}

function normalizeDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw new Error('A public display name is required');
  return name;
}