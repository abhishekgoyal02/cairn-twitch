import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph/types.js';

export type NodeShape = 'circle' | 'square' | 'diamond';
export type OutlineStyle = 'solid' | 'dashed';

export interface NodeVisualStyle {
  shape: NodeShape;
  outline: string;
  outlineStyle: OutlineStyle;
  opacity: number;
}

export interface VisibleGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ReconciledGraph {
  accepted: boolean;
  graph: VisibleGraph;
  newNodeIds: string[];
  changedNodeIds: string[];
}

export interface LoreCardModel {
  topic: string;
  answer: string;
  title: string;
  noteId: string;
  status: GraphNode['status'];
}

export interface LoreCardEvent {
  protocolVersion: 1;
  type: 'lore.card';
  revision: number;
  card: LoreCardModel;
}

export type OverlayEvent =
  | { protocolVersion: 1; type: 'graph.updated'; revision: number; graph: GraphSnapshot }
  | LoreCardEvent;
