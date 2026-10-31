import type { GraphEdge } from '../graph/types.js';

export interface LayoutPoint {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface Point2D { x: number; y: number; }

/** Reuses the same mutable layout object for every stable graph ID. */
export function mergeLayoutPoints<T extends LayoutPoint>(previous: readonly T[], incoming: readonly T[], center: Point2D): T[] {
  const byId = new Map(previous.map((point) => [point.id, point]));
  return incoming.map((point) => {
    const existing = byId.get(point.id);
    if (existing) {
      Object.assign(existing, point);
      return existing;
    }
    return { ...point, x: point.x ?? center.x, y: point.y ?? center.y };
  });
}

/** Deterministic, subtle quadratic curvature for an undirected relationship. */
export function curvedEdgePath(edge: Pick<GraphEdge, 'id'>, source: Point2D, target: Point2D): string {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 1) return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
  let hash = 0;
  for (const character of edge.id) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const side = hash % 2 === 0 ? 1 : -1;
  const offset = Math.min(42, Math.max(10, distance * 0.14)) * side;
  const midpoint = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const control = { x: midpoint.x - (dy / distance) * offset, y: midpoint.y + (dx / distance) * offset };
  return `M ${source.x} ${source.y} Q ${control.x} ${control.y} ${target.x} ${target.y}`;
}

export function neighborIds(edges: readonly Pick<GraphEdge, 'source' | 'target'>[], selectedId: string | null): Set<string> {
  const result = new Set<string>();
  if (!selectedId) return result;
  for (const edge of edges) {
    if (edge.source === selectedId) result.add(edge.target);
    if (edge.target === selectedId) result.add(edge.source);
  }
  return result;
}
