import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseStone } from '../vault/stone-schema.js';
import type { GraphDiagnostic, VaultNoteRecord } from './types.js';

export interface ScanResult {
  notes: VaultNoteRecord[];
  diagnostics: GraphDiagnostic[];
  paths: Set<string>;
}

export async function scanVault(vaultPath: string): Promise<ScanResult> {
  const root = path.resolve(vaultPath);
  const stonesPath = path.join(root, 'stones');
  const notes: VaultNoteRecord[] = [];
  const diagnostics: GraphDiagnostic[] = [];
  const paths = new Set<string>();
  let files: string[] = [];
  try {
    files = await collectMarkdown(stonesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push({ kind: 'filesystem', message: `Unable to scan vault: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  for (const file of files.sort()) {
    const relativePath = path.relative(root, file).replaceAll('\\', '/');
    paths.add(relativePath);
    try {
      const note = parseStone(await fs.readFile(file, 'utf8'));
      notes.push({ relativePath, note });
    } catch (error) {
      diagnostics.push({
        kind: 'invalid',
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const byId = new Map<string, VaultNoteRecord>();
  const unique: VaultNoteRecord[] = [];
  for (const record of notes.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const existing = byId.get(record.note.frontmatter.id);
    if (existing) {
      diagnostics.push({
        kind: 'duplicate-id',
        path: record.relativePath,
        noteId: record.note.frontmatter.id,
        message: `Duplicate note ID; keeping ${existing.relativePath}.`,
      });
      continue;
    }
    byId.set(record.note.frontmatter.id, record);
    unique.push(record);
  }
  return { notes: unique, diagnostics, paths };
}

async function collectMarkdown(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name.endsWith('.tmp')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdown(absolute));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
  }
  return files;
}
