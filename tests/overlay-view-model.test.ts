import { describe, expect, it } from 'vitest';
import { createLoreCardModel, isGraphSnapshot, nodeVisualStyle, reconcileGraph, selectVisibleGraph } from '../src/overlay/view-model.js';
import type { GraphSnapshot } from '../src/graph/types.js';

const node = (id: string, title = id, status: 'unconfirmed' | 'canon' | 'superseded' = 'unconfirmed', created = '2026-10-29T00:00:00.000Z') => ({
  id, type: 'stone', title, status, relativePath: `stones/${id}.md`, path: `stones/${id}.md`, created, author: 'Viewer',
});
const snapshot = (revision: number, nodes = [node('st_a1b2c3')], edges: GraphSnapshot['edges'] = []): GraphSnapshot => ({
  version: 1, protocolVersion: 1, revision, generatedAt: '2026-10-29T00:00:00.000Z', nodes, edges, diagnostics: [],
});

describe('overlay view model', () => {
  it('maps types and statuses to distinct visual styles', () => {
    expect(nodeVisualStyle(node('st_a1b2c3'))).toMatchObject({ shape: 'circle', outlineStyle: 'dashed', opacity: 1 });
    expect(nodeVisualStyle({ ...node('lore-1'), type: 'lore', status: 'canon' })).toMatchObject({ shape: 'diamond', outlineStyle: 'solid' });
    expect(nodeVisualStyle(node('old-1', 'Old', 'superseded'))).toMatchObject({ opacity: 0.35, outlineStyle: 'solid' });
  });

  it('keeps stable IDs, detects only genuine additions, and marks updates', () => {
    const previous = snapshot(1, [node('st_a1b2c3', 'Kevin')]);
    const changed = snapshot(2, [node('st_a1b2c3', 'Kevin updated', 'canon'), node('st_d4e5f6')]);
    const result = reconcileGraph(previous, changed);
    expect(result.accepted).toBe(true);
    expect(result.newNodeIds).toEqual(['st_d4e5f6']);
    expect(result.changedNodeIds).toEqual(['st_a1b2c3']);
    expect(reconcileGraph(changed, changed).accepted).toBe(false);
  });

  it('rejects malformed and stale snapshots without changing the view', () => {
    const previous = snapshot(3);
    expect(reconcileGraph(previous, snapshot(2)).accepted).toBe(false);
    expect(isGraphSnapshot({ revision: 4, nodes: [], edges: [] })).toBe(false);
    expect(reconcileGraph(previous, { revision: 4 } as unknown as GraphSnapshot).graph.nodes).toHaveLength(1);
  });

  it('caps nodes at 150 and excludes edges with hidden endpoints', () => {
    const nodes = Array.from({ length: 151 }, (_, index) => node(`st_${String(index).padStart(6, '0')}`, `Node ${index}`, 'unconfirmed', index === 150 ? '2026-09-01T00:00:00.000Z' : `2026-10-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`));
    const graph = selectVisibleGraph(snapshot(1, nodes, [
      { id: 'visible', source: nodes[0].id, target: nodes[1].id, type: 'wikilink' },
      { id: 'hidden', source: nodes[0].id, target: nodes[150].id, type: 'wikilink' },
    ]));
    expect(graph.nodes).toHaveLength(150);
    expect(graph.edges.map((edge) => edge.id)).toEqual(['visible']);
  });

  it('creates a grounded lore card model with source status', () => {
    expect(createLoreCardModel('Kevin', 'Unconfirmed: Kevin is the boss.', node('st_a1b2c3', 'Kevin'))).toEqual({
      topic: 'Kevin', answer: 'Unconfirmed: Kevin is the boss.', title: 'Kevin', noteId: 'st_a1b2c3', status: 'unconfirmed',
    });
  });

  it('handles long and special-character titles as data, not markup', () => {
    const title = '<Kevin & the "boss" \u{1F451}>';
    const result = reconcileGraph(null, snapshot(1, [node('st_a1b2c3', title)]));
    expect(result.graph.nodes[0].title).toBe(title);
  });

  it('keeps a one-node graph visible with no phantom edges', () => {
    const result = selectVisibleGraph(snapshot(1, [node('st_h7U0bg', 'Kevin')]));
    expect(result.nodes.map((entry) => entry.id)).toEqual(['st_h7U0bg']);
    expect(result.edges).toEqual([]);
  });

  it('preserves connected multi-node projections and filters dangling links', () => {
    const first = node('st_a1b2c3', 'Kevin');
    const second = node('st_d4e5f6', 'Story');
    const result = selectVisibleGraph(snapshot(1, [first, second], [
      { id: 'edge-1', source: first.id, target: second.id, type: 'wikilink' },
      { id: 'edge-dangling', source: first.id, target: 'missing', type: 'wikilink' },
    ]));
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([{ id: 'edge-1', source: first.id, target: second.id, type: 'wikilink' }]);
  });
});
