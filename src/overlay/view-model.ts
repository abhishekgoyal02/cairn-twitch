import type { GraphNode, GraphSnapshot } from '../graph/types.js';
import type { LoreCardModel, NodeDetailModel, NodeTooltipModel, NodeVisualStyle, ReconciledGraph, VisibleGraph } from './types.js';

/** Stable base colours for memory stones. Each is lit toward white in the SVG. */
export const NODE_GRADIENTS = ['red', 'yellow', 'blue', 'purple', 'green', 'orange', 'maroon', 'brown', 'white'] as const;

function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

export function gradientKeyForNode(node: Pick<GraphNode, 'type'> & { id?: string }): (typeof NODE_GRADIENTS)[number] {
  return NODE_GRADIENTS[stableHash(`${node.type}:${node.id ?? ''}`) % NODE_GRADIENTS.length];
}

export function shortNodeLabel(title: string): string {
  const words = title.trim().replace(/[\u2013\u2014:|()[\]{}]+/gu, ' ').split(/\s+/u).filter(Boolean);
  const filler = new Set(['the', 'a', 'an', 'community', 'thing', 'memory', 'chat', 'this', 'that', 'is', 'was', 'are', 'remember', 'after', 'as', 'failed', 'speedrun', 'attempt', 'meme']);
  const meaningful = words.filter((word) => !filler.has(word.toLocaleLowerCase()));
  const selected = (meaningful.length >= 2 ? meaningful : words).slice(0, 2);
  if (selected.length === 0) return title.trim().slice(0, 32) || 'Memory';
  return selected.map((word) => {
    const shortened = word.length > 24 ? `${word.slice(0, 23)}…` : word;
    return shortened.charAt(0).toLocaleUpperCase() + shortened.slice(1);
  }).join(' ');
}

/** Labels are centered beneath the rendered node, including in globe mode. */
export function nodeLabelOffsetY(radius: number): number { return radius + 16; }

export function nodeVisualStyle(node: Pick<GraphNode, 'type' | 'status'>): NodeVisualStyle {
  return {
    shape: node.type === 'stone' || node.type === 'lore' ? 'circle' : 'square',
    outline: '#9146ff',
    // Keep the overlay clean and readable: status is conveyed by solid stroke
    // weight/opacity rather than a dotted boundary around every new stone.
    outlineStyle: 'solid',
    opacity: node.status === 'superseded' ? 0.35 : 1,
    gradient: gradientKeyForNode(node),
    fillMode: node.type === 'lore' ? 'solid' : 'gradient',
  };
}

export function createNodeTooltipModel(node: Pick<GraphNode, 'title' | 'status' | 'author' | 'body'>): NodeTooltipModel {
  const preview = node.body?.replace(/\s+/gu, ' ').trim();
  return { title: node.title, status: node.status, author: node.author, preview: preview ? (preview.length > 140 ? `${preview.slice(0, 139)}…` : preview) : undefined };
}

export function createNodeDetailModel(
  node: Pick<GraphNode, 'id' | 'title' | 'status' | 'author' | 'created' | 'body' | 'source' | 'history' | 'supersedes'>,
  related: Array<{ id: string; title: string }>,
): NodeDetailModel {
  return { ...createNodeTooltipModel(node), id: node.id, body: node.body, created: node.created, source: node.source, history: node.history, supersedes: node.supersedes, related };
}

export function selectVisibleGraph(snapshot: GraphSnapshot, limit = 150): VisibleGraph {
  const nodes = [...snapshot.nodes]
    .sort((left, right) => right.created.localeCompare(left.created) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges };
}

export function reconcileGraph(previous: GraphSnapshot | null, incoming: GraphSnapshot, limit = 150): ReconciledGraph {
  if (!isGraphSnapshot(incoming) || (previous && incoming.revision <= previous.revision)) {
    return { accepted: false, graph: previous ? selectVisibleGraph(previous, limit) : { nodes: [], edges: [] }, newNodeIds: [], changedNodeIds: [] };
  }
  const previousById = new Map((previous?.nodes ?? []).map((node) => [node.id, node]));
  const newNodeIds = incoming.nodes.filter((node) => !previousById.has(node.id)).map((node) => node.id).sort();
  const changedNodeIds = incoming.nodes
    .filter((node) => {
      const old = previousById.get(node.id);
      return old !== undefined && (old.title !== node.title || old.status !== node.status || old.type !== node.type);
    })
    .map((node) => node.id)
    .sort();
  return { accepted: true, graph: selectVisibleGraph(incoming, limit), newNodeIds, changedNodeIds };
}

export function isGraphSnapshot(value: unknown): value is GraphSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphSnapshot>;
  return candidate.version === 1 && typeof candidate.revision === 'number' && Number.isInteger(candidate.revision) && candidate.revision >= 0 &&
    Array.isArray(candidate.nodes) && Array.isArray(candidate.edges) &&
    candidate.nodes.every(isGraphNode) && candidate.edges.every((edge) =>
      Boolean(edge && typeof edge.id === 'string' && typeof edge.source === 'string' && typeof edge.target === 'string' && edge.type === 'wikilink'),
    );
}

export function createLoreCardModel(
  topic: string,
  answer: string,
  source: Pick<GraphNode, 'id' | 'title' | 'status'>,
): LoreCardModel {
  return { topic: topic.trim(), answer: answer.trim(), title: source.title, noteId: source.id, status: source.status };
}

function isGraphNode(value: unknown): value is GraphNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Partial<GraphNode>;
  return typeof node.id === 'string' && typeof node.type === 'string' && typeof node.title === 'string' &&
    typeof node.status === 'string' && typeof node.created === 'string' && typeof node.author === 'string' &&
    typeof (node.path ?? node.relativePath) === 'string' &&
    (node.body === undefined || typeof node.body === 'string') &&
    (node.source === undefined || Array.isArray(node.source));
}
