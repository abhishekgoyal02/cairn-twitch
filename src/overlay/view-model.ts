import type { GraphNode, GraphSnapshot } from '../graph/types.js';
import type { LoreCardModel, NodeVisualStyle, ReconciledGraph, VisibleGraph } from './types.js';

const NODE_COLORS: Record<string, string> = {
  stone: '#f4b860',
  lore: '#7bdff2',
  loop: '#c7f9cc',
  person: '#d0bfff',
  stream: '#ff9f9f',
};

export function nodeVisualStyle(node: Pick<GraphNode, 'type' | 'status'>): NodeVisualStyle {
  return {
    shape: node.type === 'stone' ? 'circle' : node.type === 'lore' ? 'diamond' : 'square',
    outline: NODE_COLORS[node.type] ?? '#f4f0e8',
    outlineStyle: node.status === 'unconfirmed' ? 'dashed' : 'solid',
    opacity: node.status === 'superseded' ? 0.35 : 1,
  };
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
    typeof (node.path ?? node.relativePath) === 'string';
}
