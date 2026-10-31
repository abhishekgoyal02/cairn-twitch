import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph/types.js';
import type { NoteHistoryEvent } from '../vault/stone-schema.js';

export type NodeShape = 'circle' | 'square';
export type OutlineStyle = 'solid' | 'dashed';
export type NodeFillMode = 'gradient' | 'solid';

export interface NodeVisualStyle {
  shape: NodeShape;
  outline: string;
  outlineStyle: OutlineStyle;
  opacity: number;
  gradient: string;
  fillMode: NodeFillMode;
}

export interface NodeTooltipModel {
  title: string;
  preview?: string;
  status: string;
  author?: string;
}

export interface NodeDetailModel extends NodeTooltipModel {
  id: string;
  body?: string;
  created?: string;
  source?: Array<{ msg_id: string; ts?: string; author?: string }>;
  history?: NoteHistoryEvent[];
  supersedes?: string;
  related: Array<{ id: string; title: string }>;
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
