import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseStone, type StoneNote } from '../vault/stone-schema.js';
import { StoneVaultWriter } from '../vault/writer.js';
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
  const writer = new StoneVaultWriter(vaultPath);
  const index = new SqliteIndex(path.join(vaultPath, '.cairn', 'index.sqlite'), vaultPath);
  const valid: IndexedNote[] = [];
  const invalid: ReindexFailure[] = [];
  const ids = new Set<string>();

  try {
    for (const file of await writer.listStoneFiles()) {
      try {
        const note: StoneNote = parseStone(await fs.readFile(file, 'utf8'));
        if (ids.has(note.frontmatter.id)) {
          throw new Error(`duplicate note id: ${note.frontmatter.id}`);
        }
        ids.add(note.frontmatter.id);
        valid.push({
          id: note.frontmatter.id,
          type: note.frontmatter.type,
          title: note.frontmatter.title,
          status: note.frontmatter.status,
          author: note.frontmatter.author,
          created: note.frontmatter.created,
          relativePath: path.relative(vaultPath, file),
          body: note.body,
        });
      } catch (error) {
        invalid.push({
          file: path.relative(vaultPath, file),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    index.rebuild(valid);
    return { indexed: valid.length, invalid };
  } finally {
    index.close();
  }
}
