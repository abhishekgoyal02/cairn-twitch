import type { StoneNote } from '../vault/stone-schema.js';

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  status: StoneNote['frontmatter']['status'];
  relativePath: string;
  path: string;
  created: string;
  author: string;
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
  note: StoneNote;
}
