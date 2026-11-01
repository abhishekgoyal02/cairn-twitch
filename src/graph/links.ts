import path from 'node:path';
import type { GraphDiagnostic, GraphEdge, VaultNoteRecord } from './types.js';

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu;

export interface LinkResolution {
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
}

export function resolveWikilinks(notes: VaultNoteRecord[]): LinkResolution {
  const byKey = new Map<string, string>();
  for (const record of notes) {
    const id = record.note.frontmatter.id;
    const relative = record.relativePath.replaceAll('\\', '/');
    const filename = path.posix.basename(relative, '.md');
    const title = record.note.frontmatter.type === 'person'
      ? record.note.frontmatter.displayName
      : record.note.frontmatter.type === 'stream'
        ? `Stream ${record.note.frontmatter.streamId}`
        : record.note.frontmatter.title;
    for (const key of [id, filename, relative, `${relative.slice(0, -3)}` , title]) {
      byKey.set(normalizeTarget(key), id);
    }
  }

  const edges = new Map<string, GraphEdge>();
  const diagnostics: GraphDiagnostic[] = [];
  for (const record of notes) {
    // These are typed, scanner-validated references. They are projected from
    // front matter rather than inferred from names or note text. Their bodies
    // also contain matching wikilinks for Obsidian readability; the edge map
    // below intentionally collapses that duplicate declaration.
    for (const target of declaredRelationshipTargets(record)) {
      if (!byKey.has(normalizeTarget(target)) || target === record.note.frontmatter.id) continue;
      const id = `${record.note.frontmatter.id}->${target}:wikilink`;
      edges.set(id, { id, source: record.note.frontmatter.id, target, type: 'wikilink' });
    }
    const body = record.note.body;
    for (const match of body.matchAll(WIKILINK)) {
      const rawTarget = match[1].trim();
      const target = byKey.get(normalizeTarget(rawTarget));
      if (!target) {
        diagnostics.push({
          kind: 'broken-link',
          path: record.relativePath,
          noteId: record.note.frontmatter.id,
          message: `Unresolved wikilink: ${rawTarget}`,
        });
        continue;
      }
      const source = record.note.frontmatter.id;
      if (source === target) continue;
      const id = `${source}->${target}:wikilink`;
      edges.set(id, { id, source, target, type: 'wikilink' });
    }
  }

  return {
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: diagnostics.sort((left, right) => `${left.path}:${left.message}`.localeCompare(`${right.path}:${right.message}`)),
  };
}

function declaredRelationshipTargets(record: VaultNoteRecord): string[] {
  const frontmatter = record.note.frontmatter;
  if (frontmatter.type === 'person') return frontmatter.stoneIds;
  if (frontmatter.type === 'stream') return [...frontmatter.stoneIds, ...frontmatter.openLoopIds];
  return [];
}

function normalizeTarget(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/\.md$/iu, '')
    .toLocaleLowerCase();
}
