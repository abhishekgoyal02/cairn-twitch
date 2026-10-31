import type { GraphEdge, GraphNode } from '../graph/types.js';

/** At 26 visible active notes the overlay becomes a single, edge-on-demand globe. */
export const GLOBE_THRESHOLD = 26;

/** Globe mode deliberately uses the total visible-node count, not connectivity. */
export function globeNodeIds(nodes: Pick<GraphNode, 'id'>[], threshold = GLOBE_THRESHOLD): Set<string> {
  return nodes.length >= threshold ? new Set(nodes.map((node) => node.id)) : new Set();
}

/** In globe mode only the selected or actively dragged node exposes its real edges. */
export function globeVisibleEdges<T extends Pick<GraphEdge, 'source' | 'target'>>(
  edges: readonly T[],
  isGlobeMode: boolean,
  selectedId: string | null,
  draggingId: string | null,
): T[] {
  if (!isGlobeMode) return [...edges];
  const focus = draggingId ?? selectedId;
  return focus ? edges.filter((edge) => edge.source === focus || edge.target === focus) : [];
}

export function globeRadiusForViewport(width: number, height: number): number {
  const minimum = Math.max(1, Math.min(width, height));
  return Math.max(220, Math.min(minimum * 0.46, Math.max(220, minimum * 0.38)));
}

export function edgeEndpointId(endpoint: string | { id?: string }): string {
  return typeof endpoint === 'string' ? endpoint : endpoint?.id ?? '';
}

export interface SpherePoint {
  id: string;
  x3: number;
  y3: number;
  z3: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
}

export function connectedComponents(nodes: Pick<GraphNode, 'id'>[], edges: Pick<GraphEdge, 'source' | 'target'>[]): string[][] {
  const adjacency = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    const component: string[] = [];
    seen.add(node.id);
    while (queue.length) {
      const id = queue.shift()!;
      component.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!seen.has(neighbor)) { seen.add(neighbor); queue.push(neighbor); }
      }
    }
    components.push(component.sort());
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

export function largeComponentIds(nodes: Pick<GraphNode, 'id'>[], edges: Pick<GraphEdge, 'source' | 'target'>[], threshold = GLOBE_THRESHOLD): Set<string> {
  const result = new Set<string>();
  for (const component of connectedComponents(nodes, edges)) if (component.length >= threshold) component.forEach((id) => result.add(id));
  return result;
}

/** Deterministic Fibonacci sphere; sorting IDs makes metadata-only updates stable. */
export function fibonacciSphere(ids: string[]): SpherePoint[] {
  const ordered = [...ids].sort();
  const count = ordered.length;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  return ordered.map((id, index) => {
    // Half-step sampling avoids stacking nodes directly on either pole.
    const y = count === 1 ? 0 : 1 - (2 * (index + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * index;
    return { id, x3: Math.cos(theta) * radius, y3: y, z3: Math.sin(theta) * radius };
  });
}

export function rotateY(point: SpherePoint, angle: number): SpherePoint {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { ...point, x3: point.x3 * cos - point.z3 * sin, z3: point.x3 * sin + point.z3 * cos };
}

export function projectSphere(point: SpherePoint, center: { x: number; y: number }, radius: number, angle = 0): ProjectedPoint {
  const rotated = rotateY(point, angle);
  return { x: center.x + rotated.x3 * radius, y: center.y + rotated.y3 * radius, depth: (rotated.z3 + 1) / 2 };
}

