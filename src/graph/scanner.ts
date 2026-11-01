import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseNote, validateLoop, validateLore, validatePerson, validateStream } from '../vault/stone-schema.js';
import type { GraphDiagnostic, VaultNoteRecord } from './types.js';

export interface ScanResult {
  notes: VaultNoteRecord[];
  diagnostics: GraphDiagnostic[];
  paths: Set<string>;
}

export async function scanVault(vaultPath: string): Promise<ScanResult> {
  const root = path.resolve(vaultPath);
  const contentPaths = ['stones', 'lore', 'people', 'loops', 'streams'].map((directory) => path.join(root, directory));
  const notes: VaultNoteRecord[] = [];
  const diagnostics: GraphDiagnostic[] = [];
  const paths = new Set<string>();
  let files: string[] = [];
  try {
    for (const contentPath of contentPaths) {
      try { files.push(...await collectMarkdown(contentPath)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push({ kind: 'filesystem', message: `Unable to scan vault: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  for (const file of files.sort()) {
    const relativePath = path.relative(root, file).replaceAll('\\', '/');
    paths.add(relativePath);
    try {
      const note = parseNote(await fs.readFile(file, 'utf8'));
      notes.push({ relativePath, note });
    } catch (error) {
      diagnostics.push({
        kind: 'invalid',
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stoneIds = new Set(notes.filter((record) => record.note.frontmatter.type === 'stone').map((record) => record.note.frontmatter.id));
  const loopIds = new Set(notes.filter((record) => record.note.frontmatter.type === 'loop').map((record) => record.note.frontmatter.id));
  const validNotes = notes.filter((record) => {
    try {
      switch (record.note.frontmatter.type) {
        case 'lore':
          validateLore(record.note as import('../vault/stone-schema.js').LoreNote, stoneIds);
          break;
        case 'person': {
          validatePerson(record.note as import('../vault/stone-schema.js').PersonNote, stoneIds);
          const expected = `${record.note.frontmatter.id}.md`;
          if (path.posix.basename(record.relativePath) !== expected) throw new Error(`person filename must be ${expected}`);
          break;
        }
        case 'loop':
          validateLoop(record.note as import('../vault/stone-schema.js').LoopNote);
          break;
        case 'stream':
          validateStream(record.note as import('../vault/stone-schema.js').StreamNote, stoneIds, loopIds);
          break;
        case 'stone':
          break;
      }
      return true;
    } catch (error) {
      diagnostics.push({ kind: 'invalid', path: record.relativePath, noteId: record.note.frontmatter.id, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  });

  const byId = new Map<string, VaultNoteRecord>();
  const unique: VaultNoteRecord[] = [];
  for (const record of validNotes.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
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
