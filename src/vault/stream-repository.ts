import { createHash } from 'node:crypto';
import { streamBody, type StreamNote } from './stone-schema.js';
import { StoneVaultWriter, type PersistenceReceipt } from './writer.js';

export function streamNoteId(streamId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(streamId)) throw new Error('Invalid Twitch stream identity');
  return `sr_${createHash('sha256').update(`cairn-stream:${streamId}`, 'utf8').digest('hex')}`;
}

export class StreamNoteRepository {
  constructor(private readonly writer: StoneVaultWriter) {}

  public async createActive(streamId: string, broadcasterId: string, started: string): Promise<{ note: StreamNote; receipt?: PersistenceReceipt; existing: boolean }> {
    const existing = await this.writer.findStream(streamId);
    if (existing) return { note: existing.note, existing: true };
    const note: StreamNote = {
      frontmatter: { id: streamNoteId(streamId), type: 'stream', streamId, broadcasterId, status: 'active', started, stoneIds: [], openLoopIds: [] },
      body: streamBody([], []),
    };
    const receipt = await this.writer.writeStream(note);
    const verified = await this.writer.findStream(streamId);
    if (!verified || verified.note.frontmatter.status !== 'active') throw new Error('stream persistence verification failed');
    return { note: verified.note, receipt, existing: false };
  }

  public async find(streamId: string) { return this.writer.findStream(streamId); }
  public async unresolved() { return (await this.writer.listStreams()).filter((record) => record.note.frontmatter.status === 'active' || record.note.frontmatter.status === 'finalizing'); }

  public async update(filePath: string, note: StreamNote): Promise<StreamNote> {
    await this.writer.updateStream(filePath, note);
    const verified = await this.writer.findStream(note.frontmatter.streamId);
    if (!verified || verified.note.frontmatter.status !== note.frontmatter.status) throw new Error('stream update persistence verification failed');
    return verified.note;
  }
}
