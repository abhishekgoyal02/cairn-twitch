import { scanVault } from '../graph/scanner.js';
import { PersonNoteRepository } from '../vault/person-repository.js';
import type { StoneNote } from '../vault/stone-schema.js';
import type { NormalizedChatMessage } from './types.js';

const MAX_REPLY_LENGTH = 499;

export interface MyStonesServiceOptions {
  vaultPath: string;
  people?: PersonNoteRepository;
  log?: (message: string) => void;
}

export class MyStonesService {
  private readonly people: PersonNoteRepository;

  constructor(private readonly options: MyStonesServiceOptions) {
    this.people = options.people ?? new PersonNoteRepository(options.vaultPath);
  }

  public async list(message: NormalizedChatMessage): Promise<string> {
    const senderId = message.senderId?.trim();
    if (!senderId) return 'I could not verify your Twitch identity for contribution history.';
    let person;
    try {
      person = await this.people.find(senderId);
    } catch {
      this.options.log?.('Unable to read the requesting viewer contribution record.');
      return 'Your contribution history is temporarily unavailable.';
    }
    if (!person) return 'You have not added any stones yet.';

    const scan = await scanVault(this.options.vaultPath);
    const stones = new Map<string, StoneNote>();
    for (const record of scan.notes) {
      if (record.note.frontmatter.type === 'stone') stones.set(record.note.frontmatter.id, record.note as StoneNote);
    }
    const contributions = [...new Set(person.note.frontmatter.stoneIds)]
      .map((id) => stones.get(id))
      .filter((note): note is StoneNote => Boolean(note))
      .sort((left, right) => right.frontmatter.created.localeCompare(left.frontmatter.created)
        || left.frontmatter.id.localeCompare(right.frontmatter.id));
    if (contributions.length === 0) return 'You have not added any active stones yet.';

    const recent = contributions.slice(0, 3).map((note) => `${shortTitle(note.frontmatter.title)} (${note.frontmatter.id})`);
    return bounded(`You have added ${contributions.length} stone${contributions.length === 1 ? '' : 's'}. Recent: ${recent.join(', ')}.`);
  }
}

function shortTitle(title: string): string {
  const chars = Array.from(title.replace(/\s+/gu, ' ').trim());
  return chars.length <= 72 ? chars.join('') : `${chars.slice(0, 71).join('')}…`;
}

function bounded(value: string): string {
  const chars = Array.from(value);
  return chars.length <= MAX_REPLY_LENGTH ? value : `${chars.slice(0, MAX_REPLY_LENGTH - 1).join('')}…`;
}
