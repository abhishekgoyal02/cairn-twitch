import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { makeStoneFilename } from './filename.js';
import { parseStone, parseNote, serializeStone, serializeNote, validateLore, validateLoop, validatePerson, validateStream, type StoneNote, type LoreNote, type LoopNote, type PersonNote, type StreamNote, type VaultNote } from './stone-schema.js';

export interface PersistenceReceipt {
  noteId: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  verified: true;
}

export class StoneVaultWriter {
  public readonly stonesPath: string;

  constructor(public readonly vaultPath: string) {
    this.stonesPath = path.join(vaultPath, 'stones');
  }

  public async ensureLayout(): Promise<void> {
    await fs.mkdir(this.stonesPath, { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, 'lore'), { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, 'people'), { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, 'loops'), { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, 'streams'), { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, '.cairn'), { recursive: true });
  }

  public async writeLore(note: LoreNote): Promise<PersistenceReceipt> {
    validateLore(note);
    return this.writeTypedNote(note, 'lore');
  }

  public async writeLoop(note: LoopNote): Promise<PersistenceReceipt> {
    validateLoop(note);
    return this.writeTypedNote(note, 'loops');
  }

  public async writePerson(note: PersonNote): Promise<PersistenceReceipt> {
    validatePerson(note);
    const filename = `${note.frontmatter.id}.md`;
    return this.writeTypedNote(note, 'people', filename);
  }

  public async writeStream(note: StreamNote): Promise<PersistenceReceipt> {
    validateStream(note);
    return this.writeTypedNote(note, 'streams', `${note.frontmatter.id}.md`);
  }

  private async writeTypedNote(note: VaultNote, directoryName: 'lore' | 'loops' | 'people' | 'streams', filename?: string): Promise<PersistenceReceipt> {
    const directory = path.join(this.vaultPath, directoryName);
    await fs.mkdir(directory, { recursive: true });
    const noteFilename = filename ?? (note.frontmatter.type === 'person' || note.frontmatter.type === 'stream'
      ? `${note.frontmatter.id}.md`
      : makeStoneFilename(note.frontmatter.created, note.frontmatter.title, note.frontmatter.id));
    const finalPath = path.join(directory, noteFilename);
    const tempPath = `${finalPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      try { await fs.access(finalPath); throw new Error(`note filename already exists: ${noteFilename}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(serializeNote(note), 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(tempPath, finalPath);
      return await this.verifyReceipt(note.frontmatter.id, finalPath, note.frontmatter.type);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined); await fs.unlink(tempPath).catch(() => undefined); throw error;
    }
  }

  public async hasStoneId(id: string): Promise<boolean> {
    for (const file of await this.listNoteFiles()) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        if (matter(raw).data.id === id) return true;
        if (parseNote(raw).frontmatter.id === id) return true;
      } catch {
        // Reindex will report malformed files; collision checks ignore malformed notes.
      }
    }
    return false;
  }

  public async hasNoteId(id: string): Promise<boolean> { return this.hasStoneId(id); }

  public async listStoneFiles(): Promise<string[]> {
    await this.ensureLayout();
    const entries = await fs.readdir(this.stonesPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(this.stonesPath, entry.name));
  }

  public async listNoteFiles(): Promise<string[]> {
    await this.ensureLayout();
    const directories = ['stones', 'lore', 'people', 'loops', 'streams'];
    const result: string[] = [];
    for (const directory of directories) {
      const directoryPath = path.join(this.vaultPath, directory);
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      result.push(...entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).map((entry) => path.join(directoryPath, entry.name)));
    }
    return result;
  }

  public async writeStone(note: StoneNote): Promise<PersistenceReceipt> {
    const markdown = serializeStone(note);
    await this.ensureLayout();
    const filename = makeStoneFilename(note.frontmatter.created, note.frontmatter.title, note.frontmatter.id);
    const finalPath = path.join(this.stonesPath, filename);
    const tempPath = `${finalPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
      try {
        await fs.access(finalPath);
        throw new Error(`stone filename already exists: ${filename}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(markdown, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, finalPath);
      return await this.verifyReceipt(note.frontmatter.id, finalPath, note.frontmatter.type);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async verifyReceipt(noteId: string, finalPath: string, type: VaultNote['frontmatter']['type']): Promise<PersistenceReceipt> {
    const stat = await fs.stat(finalPath);
    const raw = await fs.readFile(finalPath, 'utf8');
    const parsed = parseNote(raw);
    if (!parsed || parsed.frontmatter.id !== noteId || parsed.frontmatter.type !== type) throw new Error('persisted note verification failed');
    return {
      noteId,
      absolutePath: path.resolve(finalPath),
      relativePath: path.relative(this.vaultPath, finalPath).replaceAll('\\', '/'),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      verified: true,
    };
  }

  public async findTrashedStone(id: string): Promise<{ note: StoneNote; filePath: string } | undefined> {
    const directory = path.join(this.vaultPath, '_trash');
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const filePath = path.join(directory, entry.name);
        try { const note = parseStone(await fs.readFile(filePath, 'utf8')); if (note.frontmatter.id === id) return { note, filePath }; } catch { /* malformed trash is not actionable */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return undefined;
  }

  /** Locate a note by its stable front-matter identity, never by user input path. */
  public async findStone(id: string): Promise<{ note: StoneNote; filePath: string } | undefined> {
    for (const filePath of await this.listStoneFiles()) {
      try {
        const note = parseStone(await fs.readFile(filePath, 'utf8'));
        if (note.frontmatter.id === id) return { note, filePath };
      } catch {
        // Validation is reported by reindex/graph; governance never edits malformed notes.
      }
    }
    return undefined;
  }

  public async findLoop(id: string): Promise<{ note: LoopNote; filePath: string } | undefined> {
    const directory = path.join(this.vaultPath, 'loops');
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const filePath = path.join(directory, entry.name);
        try {
          const note = parseNote(await fs.readFile(filePath, 'utf8'));
          if (note.frontmatter.type === 'loop' && note.frontmatter.id === id) return { note: note as LoopNote, filePath };
        } catch { /* malformed loops are not actionable */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return undefined;
  }

  public async listLoops(): Promise<Array<{ note: LoopNote; filePath: string }>> {
    const directory = path.join(this.vaultPath, 'loops');
    try {
      const loops: Array<{ note: LoopNote; filePath: string }> = [];
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const filePath = path.join(directory, entry.name);
        try { const note = parseNote(await fs.readFile(filePath, 'utf8')); if (note.frontmatter.type === 'loop') loops.push({ note: note as LoopNote, filePath }); } catch { /* skip malformed */ }
      }
      return loops.sort((left, right) => left.note.frontmatter.created.localeCompare(right.note.frontmatter.created) || left.note.frontmatter.id.localeCompare(right.note.frontmatter.id));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  public async findStream(streamId: string): Promise<{ note: StreamNote; filePath: string } | undefined> {
    for (const entry of await this.listStreams()) if (entry.note.frontmatter.streamId === streamId) return entry;
    return undefined;
  }

  public async listStreams(): Promise<Array<{ note: StreamNote; filePath: string }>> {
    const directory = path.join(this.vaultPath, 'streams');
    try {
      const streams: Array<{ note: StreamNote; filePath: string }> = [];
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const filePath = path.join(directory, entry.name);
        try { const note = parseNote(await fs.readFile(filePath, 'utf8')); if (note.frontmatter.type === 'stream') streams.push({ note: note as StreamNote, filePath }); } catch { /* scanner reports malformed records */ }
      }
      return streams.sort((a, b) => a.note.frontmatter.started.localeCompare(b.note.frontmatter.started) || a.note.frontmatter.id.localeCompare(b.note.frontmatter.id));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  /** Atomically replace only Cairn-managed front matter while preserving the body. */
  public async updateStone(filePath: string, note: StoneNote): Promise<void> {
    await this.updateNote(filePath, note);
  }

  public async updateLoop(filePath: string, note: LoopNote): Promise<void> { await this.updateNote(filePath, note); }
  public async updatePerson(filePath: string, note: PersonNote): Promise<void> { await this.updateNote(filePath, note); }
  public async updateStream(filePath: string, note: StreamNote): Promise<void> { await this.updateNote(filePath, note); }

  private async updateNote(filePath: string, note: VaultNote): Promise<void> {
    const markdown = serializeNote(note);
    const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(markdown, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /** Move a validated note to the vault trash without allowing path traversal. */
  public async moveToTrash(filePath: string, id: string): Promise<string> {
    const root = path.resolve(this.vaultPath);
    const source = path.resolve(filePath);
    const relative = path.relative(root, source);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.toLowerCase().startsWith('stones')) {
      throw new Error('note path is outside the active stones directory');
    }
    const trash = path.join(root, '_trash');
    await fs.mkdir(trash, { recursive: true });
    const base = path.basename(source);
    let target = path.join(trash, base);
    try { await fs.access(target); target = path.join(trash, `${id}-${base}`); } catch { /* available */ }
    await fs.rename(source, target);
    return target;
  }
}
