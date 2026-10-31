import path from 'node:path';
import { promises as fs } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { scanVault } from './scanner.js';
import { projectGraph, type GraphProjector } from './projection.js';
import type { GraphSnapshot, VaultNoteRecord } from './types.js';
import { SqliteIndex, type IndexedNote } from '../index/sqlite-index.js';

export interface GraphServiceOptions {
  vaultPath: string;
  index: SqliteIndex;
  debounceMs?: number;
  renameGraceMs?: number;
  project?: GraphProjector;
  scan?: typeof scanVault;
  log?: (message: string) => void;
}

export class GraphService {
  private readonly vaultPath: string;
  private readonly index: SqliteIndex;
  private readonly debounceMs: number;
  private readonly renameGraceMs: number;
  private readonly project: GraphProjector;
  private readonly scan: typeof scanVault;
  private readonly log: (message: string) => void;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private renameTimer?: NodeJS.Timeout;
  private reconcilePromise: Promise<void> = Promise.resolve();
  private notes = new Map<string, VaultNoteRecord>();
  private missingSince = new Map<string, number>();
  private snapshot: GraphSnapshot = {
    version: 1, protocolVersion: 1, revision: 0, generatedAt: new Date(0).toISOString(),
    nodes: [], edges: [], diagnostics: [],
  };
  private ready = false;
  private lifecycle: 'idle' | 'initializing' | 'ready' | 'failed' | 'stopped' = 'idle';
  private pendingDuringStartup = false;
  private lastError?: Error;
  private listeners = new Set<(snapshot: GraphSnapshot) => void>();

  constructor(options: GraphServiceOptions) {
    this.vaultPath = path.resolve(options.vaultPath);
    this.index = options.index;
    this.debounceMs = options.debounceMs ?? 100;
    this.renameGraceMs = options.renameGraceMs ?? 250;
    this.project = options.project ?? projectGraph;
    this.scan = options.scan ?? scanVault;
    this.log = options.log ?? (() => undefined);
  }

  public async start(): Promise<void> {
    if (this.lifecycle === 'ready' || this.lifecycle === 'initializing') return;
    this.lifecycle = 'initializing';
    this.ready = false;
    // Ensure watched roots exist before Chokidar subscribes. Otherwise a file
    // created while a missing directory is being materialized can be missed.
    await fs.mkdir(path.join(this.vaultPath, 'stones'), { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, 'lore'), { recursive: true });
    // Watch every active Markdown content directory. The scanner and index
    // already treat stones and lore as authoritative sources; watching both
    // keeps Obsidian edits live without duplicating watcher instances.
    this.watcher = chokidar.watch([
      path.join(this.vaultPath, 'stones'),
      path.join(this.vaultPath, 'lore'),
    ], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
      ignored: (watchedPath) => this.isIgnored(watchedPath),
    });
    const changed = (): void => {
      if (this.lifecycle === 'initializing') this.pendingDuringStartup = true;
      else this.schedule();
    };
    this.watcher.on('add', changed);
    this.watcher.on('change', changed);
    this.watcher.on('unlink', changed);
    this.watcher.on('error', (error) => this.log(`Vault watcher error: ${error instanceof Error ? error.message : String(error)}`));
    try {
      await this.reconcile(false);
      if (this.lastError) throw this.lastError;
      // Always perform one drain scan after the first scan. This closes the
      // boundary where a file changes before the watcher has delivered its
      // event (or between the scan and readiness).
      this.pendingDuringStartup = true;
      do {
        this.pendingDuringStartup = false;
        await this.reconcile(false);
        if (this.lastError) throw this.lastError;
      } while (this.pendingDuringStartup);
      this.lifecycle = 'ready';
      this.ready = true;
      if (this.pendingDuringStartup) {
        this.lifecycle = 'initializing';
        do {
          this.pendingDuringStartup = false;
          await this.reconcile(false);
        } while (this.pendingDuringStartup);
        this.lifecycle = 'ready';
        this.ready = true;
      }
      if (this.lastError) throw this.lastError;
    } catch (error) {
      this.lifecycle = 'failed';
      this.ready = false;
      await this.watcher.close();
      this.watcher = undefined;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.renameTimer) clearTimeout(this.renameTimer);
    this.timer = undefined;
    this.renameTimer = undefined;
    this.ready = false;
    this.lifecycle = 'stopped';
    await this.reconcilePromise;
    await this.watcher?.close();
    this.watcher = undefined;
  }

  public isReady(): boolean { return this.ready; }
  public getLifecycle(): string { return this.lifecycle; }
  public getSnapshot(): GraphSnapshot { return structuredClone(this.snapshot); }
  public subscribe(listener: (snapshot: GraphSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.renameTimer) clearTimeout(this.renameTimer);
    this.timer = undefined;
    this.renameTimer = undefined;
    await this.reconcile(true);
  }

  private schedule(delay = this.debounceMs): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile(false);
    }, delay);
  }

  private reconcile(forceFinalize: boolean): Promise<void> {
    this.reconcilePromise = this.reconcilePromise.then(async () => {
      const result = await this.scan(this.vaultPath);
      const nextNotes = new Map<string, VaultNoteRecord>();
      for (const record of result.notes) nextNotes.set(record.relativePath, record);
      const incomingIds = new Set(result.notes.map((record) => record.note.frontmatter.id));
      const now = Date.now();
      let delayedRemoval = false;
      for (const [relativePath, previous] of this.notes) {
        if (nextNotes.has(relativePath)) {
          this.missingSince.delete(relativePath);
          continue;
        }
        if (result.paths.has(relativePath)) {
          nextNotes.set(relativePath, previous);
          continue;
        }
        if (incomingIds.has(previous.note.frontmatter.id)) {
          this.missingSince.delete(relativePath);
          continue;
        }
        const since = this.missingSince.get(relativePath) ?? now;
        this.missingSince.set(relativePath, since);
        if (!forceFinalize && now - since < this.renameGraceMs) {
          nextNotes.set(relativePath, previous);
          delayedRemoval = true;
        } else {
          this.missingSince.delete(relativePath);
        }
      }
      const records = [...nextNotes.values()];
      const next = this.project(records, this.snapshot.revision + 1, result.diagnostics);
      this.index.rebuild(records.map(toIndexedNote));
      if (graphContent(this.snapshot) !== graphContent(next) || this.snapshot.revision === 0) {
        this.snapshot = next;
        this.notes = nextNotes;
        for (const listener of this.listeners) {
          try { listener(this.getSnapshot()); }
          catch (error) { this.log(`Graph listener failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } else {
        this.notes = nextNotes;
      }
      this.lastError = undefined;
      if (delayedRemoval && !forceFinalize) {
        const earliest = Math.min(...[...this.missingSince.values()].map((since) => since + this.renameGraceMs));
        this.renameTimer = setTimeout(() => { this.renameTimer = undefined; this.schedule(); }, Math.max(this.debounceMs, earliest - Date.now()));
      }
    }).catch((error) => {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.log(`Vault reconciliation failed: ${this.lastError.message}`);
    });
    return this.reconcilePromise;
  }

  private isIgnored(input: string): boolean {
    const absolute = path.resolve(input);
    const relative = path.relative(this.vaultPath, absolute).replaceAll('\\', '/');
    return relative.startsWith('..') || relative.split('/').some((part) => part.startsWith('.') || part.startsWith('_')) || relative.endsWith('.tmp');
  }
}

function toIndexedNote(record: VaultNoteRecord): IndexedNote {
  return {
    id: record.note.frontmatter.id, type: record.note.frontmatter.type, title: record.note.frontmatter.title,
    status: record.note.frontmatter.status, author: record.note.frontmatter.author, created: record.note.frontmatter.created,
    relativePath: record.relativePath, body: record.note.body,
  };
}

function graphContent(snapshot: GraphSnapshot): string {
  return JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges, diagnostics: snapshot.diagnostics });
}
