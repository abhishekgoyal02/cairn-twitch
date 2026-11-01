import type { GraphDiagnostic, GraphNode, GraphSnapshot, VaultNoteRecord } from './types.js';
import { resolveWikilinks } from './links.js';
import type { LoopNote, LoreNote, PersonNote, StoneNote, StreamNote } from '../vault/stone-schema.js';

export type GraphProjector = (notes: VaultNoteRecord[], revision: number, diagnostics?: GraphDiagnostic[]) => GraphSnapshot;

export const projectGraph: GraphProjector = (notes, revision, diagnostics = []): GraphSnapshot => {
  const projectableNotes = notes as Array<VaultNoteRecord & { note: StoneNote | LoreNote | PersonNote | LoopNote | StreamNote }>;
  const nodes: GraphNode[] = projectableNotes
    .map(({ relativePath, note }) => toGraphNode(relativePath, note))
    .sort((left, right) => left.id.localeCompare(right.id));
  const links = resolveWikilinks(projectableNotes);
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

function toGraphNode(relativePath: string, note: StoneNote | LoreNote | PersonNote | LoopNote | StreamNote): GraphNode {
  const base = { id: note.frontmatter.id, type: note.frontmatter.type, relativePath, path: relativePath, body: note.body };
  switch (note.frontmatter.type) {
    case 'stone': return { ...base, title: note.frontmatter.title, status: note.frontmatter.status, created: note.frontmatter.created, author: note.frontmatter.author, source: note.frontmatter.source.map((source) => ({ ...source })), history: note.frontmatter.history?.map((event) => ({ ...event })), supersedes: note.frontmatter.supersedes };
    case 'lore': return { ...base, title: note.frontmatter.title, status: note.frontmatter.status, created: note.frontmatter.created, author: note.frontmatter.author, history: note.frontmatter.history?.map((event) => ({ ...event })) };
    case 'person': return { ...base, title: note.frontmatter.displayName, status: 'active', created: '', author: '', contributedStoneCount: note.frontmatter.stoneIds.length };
    case 'loop': return { ...base, title: note.frontmatter.title, status: note.frontmatter.status, created: note.frontmatter.created, author: note.frontmatter.owner, source: note.frontmatter.source?.map((source) => ({ ...source })), history: note.frontmatter.history?.map((event) => ({ ...event })) };
    case 'stream': return { ...base, title: 'Stream session', status: note.frontmatter.status, created: note.frontmatter.started, author: '', ended: note.frontmatter.ended, recoveryObservedAt: note.frontmatter.recoveryObservedAt };
  }
}
