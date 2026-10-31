import path from 'node:path';
import { scanVault } from '../graph/scanner.js';
import { SqliteIndex, type IndexedNote } from './sqlite-index.js';

export interface ReindexFailure {
  file: string;
  reason: string;
}

export interface ReindexSummary {
  indexed: number;
  invalid: ReindexFailure[];
}

export async function reindexVault(vaultPath: string): Promise<ReindexSummary> {
  const index = new SqliteIndex(path.join(vaultPath, '.cairn', 'index.sqlite'), vaultPath);
  const valid: IndexedNote[] = [];
  const invalid: ReindexFailure[] = [];
  const ids = new Set<string>();

  try {
    const scanned = await scanVault(vaultPath);
    for (const record of scanned.notes) {
      try {
        const note = record.note;
        if (ids.has(note.frontmatter.id)) throw new Error(`duplicate note id: ${note.frontmatter.id}`);
        ids.add(note.frontmatter.id);
        valid.push({
          id: note.frontmatter.id,
          type: note.frontmatter.type,
          title: note.frontmatter.title,
          status: note.frontmatter.status,
          author: note.frontmatter.author,
          created: note.frontmatter.created,
          relativePath: record.relativePath,
          body: note.body,
        });
      } catch (error) {
        invalid.push({
          file: record.relativePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const diagnostic of scanned.diagnostics) if (diagnostic.path) invalid.push({ file: diagnostic.path.replaceAll('/', path.sep), reason: diagnostic.message });

    index.rebuild(valid);
    return { indexed: valid.length, invalid };
  } finally {
    index.close();
  }
}
