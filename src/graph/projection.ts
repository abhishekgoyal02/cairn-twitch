import type { GraphDiagnostic, GraphNode, GraphSnapshot, VaultNoteRecord } from './types.js';
import { resolveWikilinks } from './links.js';

export type GraphProjector = (notes: VaultNoteRecord[], revision: number, diagnostics?: GraphDiagnostic[]) => GraphSnapshot;

export const projectGraph: GraphProjector = (notes, revision, diagnostics = []): GraphSnapshot => {
  const nodes: GraphNode[] = notes
    .map(({ relativePath, note }) => ({
      id: note.frontmatter.id,
      type: note.frontmatter.type,
      title: note.frontmatter.title,
      status: note.frontmatter.status,
      relativePath,
      path: relativePath,
      created: note.frontmatter.created,
      author: note.frontmatter.author,
      body: note.body,
      source: note.frontmatter.type === 'stone' ? note.frontmatter.source.map((source) => ({ ...source })) : undefined,
      history: note.frontmatter.history?.map((event) => ({ ...event })),
      supersedes: note.frontmatter.type === 'stone' ? note.frontmatter.supersedes : undefined,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const links = resolveWikilinks(notes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = links.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return {
    version: 1,
    protocolVersion: 1,
    revision,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    diagnostics: [...diagnostics, ...links.diagnostics].sort((left, right) =>
      `${left.kind}:${left.path ?? ''}:${left.message}`.localeCompare(`${right.kind}:${right.path ?? ''}:${right.message}`),
    ),
  };
};
