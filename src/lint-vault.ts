import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanVault } from './graph/scanner.js';
import { parseNote } from './vault/stone-schema.js';
import { resolveWikilinks } from './graph/links.js';

export interface LintResult { errors: Array<{ file: string; reason: string }>; valid: number; }

export async function lintVault(vaultPath: string): Promise<LintResult> {
  const root = path.resolve(vaultPath); const scan = await scanVault(root);
  const errors = scan.diagnostics.map((d) => ({ file: d.path ?? '<vault>', reason: d.message }));
  const activeIds = new Set(scan.notes.map((record) => record.note.frontmatter.id));
  for (const diagnostic of resolveWikilinks(scan.notes).diagnostics) if (diagnostic.path) errors.push({ file: diagnostic.path, reason: diagnostic.message });
  for (const record of scan.notes) {
    const note = record.note;
    if (note.frontmatter.type === 'stone' && note.frontmatter.supersedes && !activeIds.has(note.frontmatter.supersedes)) {
      errors.push({ file: record.relativePath, reason: `supersedes references missing active note ${note.frontmatter.supersedes}` });
    }
    for (const match of note.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)) {
      const target = match[1].trim();
      if (target.startsWith('st_') && !activeIds.has(target)) errors.push({ file: record.relativePath, reason: `broken wikilink or trashed target: ${target}` });
    }
  }
  return { errors, valid: Math.max(0, scan.notes.length - errors.length) };
}

