import { randomBytes } from 'node:crypto';
import type { StoneSource, LoopNote } from './stone-schema.js';
import { LOOP_ID_PATTERN, validateLoop } from './stone-schema.js';
import { StoneVaultWriter, type PersistenceReceipt } from './writer.js';

export interface CreateLoopInput {
  title: string;
  owner: string;
  created: string;
  source?: StoneSource[];
  body?: string;
}

export class LoopNoteRepository {
  private readonly completionLocks = new Map<string, Promise<void>>();
  constructor(
    private readonly writer: StoneVaultWriter,
    private readonly idFactory: () => string = () => `lp_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/gu, '').slice(0, 6).padEnd(6, '0')}`,
  ) {}

  public async create(input: CreateLoopInput): Promise<{ note: LoopNote; receipt: PersistenceReceipt }> {
    let id = this.idFactory();
    for (let attempts = 0; await this.writer.hasNoteId(id); attempts += 1) {
      if (attempts >= 16) throw new Error('Unable to generate a unique loop ID');
      id = this.idFactory();
    }
    const frontmatter: LoopNote['frontmatter'] = {
        id, type: 'loop', title: input.title.trim(), status: 'open', created: input.created,
        owner: input.owner.trim(), source: input.source?.map((entry) => ({ ...entry })),
        history: [{ type: 'created', at: input.created }],
    };
    if (frontmatter.source === undefined) delete frontmatter.source;
    const note: LoopNote = { frontmatter, body: input.body?.trim() ?? '' };
    validateLoop(note);
    const receipt = await this.writer.writeLoop(note);
    return { note, receipt };
  }

  public async find(id: string): Promise<{ note: LoopNote; filePath: string } | undefined> {
    if (!LOOP_ID_PATTERN.test(id)) return undefined;
    return this.writer.findLoop(id);
  }

  public async list(): Promise<Array<{ note: LoopNote; filePath: string }>> { return this.writer.listLoops(); }
  public async listOpen(): Promise<Array<{ note: LoopNote; filePath: string }>> {
    return (await this.list()).filter((entry) => entry.note.frontmatter.status === 'open');
  }

  public async complete(id: string, completedAt: string, actor?: string): Promise<LoopNote> {
    const previous = this.completionLocks.get(id) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.completionLocks.set(id, current);
    await previous;
    try {
      const record = await this.find(id);
      if (!record) throw new Error(`Unknown loop ID: ${id}`);
      if (record.note.frontmatter.status === 'done') throw new Error(`Loop ${id} is already done`);
      const event = { type: 'completed' as const, at: completedAt, ...(actor?.trim() ? { actor: actor.trim() } : {}) };
      const note: LoopNote = {
        ...record.note,
        frontmatter: {
          ...record.note.frontmatter,
          status: 'done',
          history: [...(record.note.frontmatter.history ?? []), event],
        },
      };
      validateLoop(note);
      await this.writer.updateLoop(record.filePath, note);
      const persisted = await this.find(id);
      if (!persisted || persisted.note.frontmatter.status !== 'done') throw new Error('loop completion persistence verification failed');
      return persisted.note;
    } finally {
      release?.();
      if (this.completionLocks.get(id) === current) this.completionLocks.delete(id);
    }
  }
}
