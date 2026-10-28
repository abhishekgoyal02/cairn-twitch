import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { makeStoneFilename } from './filename.js';
import { parseStone, serializeStone, type StoneNote } from './stone-schema.js';

export class StoneVaultWriter {
  public readonly stonesPath: string;

  constructor(public readonly vaultPath: string) {
    this.stonesPath = path.join(vaultPath, 'stones');
  }

  public async ensureLayout(): Promise<void> {
    await fs.mkdir(this.stonesPath, { recursive: true });
    await fs.mkdir(path.join(this.vaultPath, '.cairn'), { recursive: true });
  }

  public async hasStoneId(id: string): Promise<boolean> {
    for (const file of await this.listStoneFiles()) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        if (matter(raw).data.id === id) return true;
        if (parseStone(raw).frontmatter.id === id) return true;
      } catch {
        // Reindex will report malformed files; collision checks ignore malformed notes.
      }
    }
    return false;
  }

  public async listStoneFiles(): Promise<string[]> {
    await this.ensureLayout();
    const entries = await fs.readdir(this.stonesPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(this.stonesPath, entry.name));
  }

  public async writeStone(note: StoneNote): Promise<string> {
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
      return finalPath;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
