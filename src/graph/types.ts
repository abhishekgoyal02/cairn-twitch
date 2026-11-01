import type { VaultNote, NoteHistoryEvent, StoneSource, StoneStatus, LoopStatus, StreamStatus } from '../vault/stone-schema.js';

export type GraphNodeStatus = StoneStatus | LoopStatus | StreamStatus | 'active';

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  status: GraphNodeStatus;
  relativePath: string;
  path: string;
  created: string;
  author: string;
  /** Public note content used by the local overlay detail view. */
  body?: string;
  /** Source references already present in the note; never a full chat log. */
  source?: StoneSource[];
  /** Cairn-recorded lifecycle entries, if the Markdown front matter has them. */
  history?: NoteHistoryEvent[];
  supersedes?: string;
  /** Public, Markdown-derived details needed by the local inspector. */
  contributedStoneCount?: number;
  ended?: string;
  recoveryObservedAt?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'wikilink';
}

export interface GraphDiagnostic {
  kind: 'invalid' | 'duplicate-id' | 'broken-link' | 'filesystem';
  path?: string;
  noteId?: string;
  message: string;
}

export interface GraphSnapshot {
  version: 1;
  protocolVersion: 1;
  revision: number;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
}

export interface VaultNoteRecord {
  relativePath: string;
  note: VaultNote;
}
