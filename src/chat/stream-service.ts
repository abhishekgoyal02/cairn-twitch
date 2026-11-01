import path from 'node:path';
import type { ActiveStreamProvider } from './stream-context.js';
import type { NormalizedChatMessage } from './types.js';
import { scanVault } from '../graph/scanner.js';
import { SqliteIndex } from '../index/sqlite-index.js';
import { streamBody, type LoopNote, type StoneNote, type StreamNote } from '../vault/stone-schema.js';
import { StreamNoteRepository } from '../vault/stream-repository.js';

export interface StreamOnlineEvent { broadcasterId: string; streamId: string; startedAt: string; }
export interface StreamOfflineEvent { broadcasterId: string; streamId?: string; occurredAt?: string; }
export interface LiveStream { streamId: string; startedAt: string; }

export class StreamService implements ActiveStreamProvider {
  private active?: StreamNote;
  private serial = Promise.resolve();

  constructor(
    private readonly options: { vaultPath: string; broadcasterId: string; streams: StreamNoteRepository; index?: SqliteIndex; log?: (message: string) => void },
  ) {}

  public async onOnline(event: StreamOnlineEvent): Promise<void> {
    await this.run(async () => {
      if (event.broadcasterId !== this.options.broadcasterId || !validId(event.streamId) || !validIso(event.startedAt)) return;
      const unresolved = await this.options.streams.unresolved();
      for (const prior of unresolved) {
        if (prior.note.frontmatter.streamId !== event.streamId && prior.note.frontmatter.broadcasterId === event.broadcasterId) {
          await this.interrupt(prior.note, prior.filePath, new Date().toISOString());
        }
      }
      const result = await this.options.streams.createActive(event.streamId, event.broadcasterId, event.startedAt);
      this.active = result.note.frontmatter.status === 'active' ? result.note : undefined;
      if (!result.existing) this.options.log?.(`Stream lifecycle: active stream persisted id=${result.note.frontmatter.id}.`);
    });
  }

  public async onOffline(event: StreamOfflineEvent): Promise<void> {
    await this.run(async () => {
      if (event.broadcasterId !== this.options.broadcasterId) return;
      const streamId = event.streamId ?? this.active?.frontmatter.streamId;
      if (!streamId) { this.options.log?.('Stream lifecycle: offline event had no matching active stream.'); return; }
      const record = await this.options.streams.find(streamId);
      if (!record || record.note.frontmatter.broadcasterId !== event.broadcasterId) { this.options.log?.('Stream lifecycle: offline event did not match a persisted stream.'); return; }
      if (record.note.frontmatter.status === 'completed' || record.note.frontmatter.status === 'interrupted') return;
      const ended = event.occurredAt && validIso(event.occurredAt) ? event.occurredAt : undefined;
      const scan = await scanVault(this.options.vaultPath);
      const stones = scan.notes.filter((r): r is typeof r & { note: StoneNote } => r.note.frontmatter.type === 'stone' && r.note.frontmatter.streamId === streamId)
        .map((r) => r.note.frontmatter.id).sort();
      const loops = scan.notes.filter((r): r is typeof r & { note: LoopNote } => r.note.frontmatter.type === 'loop' && r.note.frontmatter.status === 'open')
        .map((r) => r.note.frontmatter.id).sort();
      const updated: StreamNote = { frontmatter: { ...record.note.frontmatter, status: 'completed', ...(ended ? { ended } : {}), stoneIds: stones, openLoopIds: loops }, body: streamBody(stones, loops) };
      const persisted = await this.options.streams.update(record.filePath, updated);
      const verified = await this.options.streams.find(streamId);
      if (verified) this.options.index?.upsert(persisted, path.relative(this.options.vaultPath, verified.filePath));
      this.active = undefined;
      this.options.log?.(`Stream lifecycle: completed stream id=${persisted.frontmatter.id} stones=${stones.length} open_loops=${loops.length}.`);
    });
  }

  public async reconcile(live: LiveStream | null | undefined): Promise<void> {
    await this.run(async () => {
      const unresolved = await this.options.streams.unresolved();
      const match = live && unresolved.find((record) => record.note.frontmatter.streamId === live.streamId);
      if (match) { this.active = match.note; return; }
      for (const record of unresolved) await this.interrupt(record.note, record.filePath, new Date().toISOString());
      if (live) {
        const created = await this.options.streams.createActive(live.streamId, this.options.broadcasterId, live.startedAt);
        this.active = created.note.frontmatter.status === 'active' ? created.note : undefined;
      }
    });
  }

  public async streamIdFor(message: Pick<NormalizedChatMessage, 'timestamp'>): Promise<string | undefined> {
    const active = this.active;
    if (!active || active.frontmatter.status !== 'active' || Number.isNaN(message.timestamp.getTime())) return undefined;
    return message.timestamp.getTime() >= Date.parse(active.frontmatter.started) ? active.frontmatter.streamId : undefined;
  }

  private async interrupt(note: StreamNote, filePath: string, observedAt: string): Promise<void> {
    const updated: StreamNote = { frontmatter: { ...note.frontmatter, status: 'interrupted', recoveryObservedAt: observedAt }, body: note.body };
    const persisted = await this.options.streams.update(filePath, updated);
    this.options.index?.upsert(persisted, path.relative(this.options.vaultPath, filePath));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    const queued = this.serial.then(action, action);
    this.serial = queued.catch(() => undefined);
    await queued;
  }
}

function validId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/u.test(value); }
function validIso(value: string): boolean { return /T/u.test(value) && /Z$/u.test(value) && !Number.isNaN(Date.parse(value)); }
