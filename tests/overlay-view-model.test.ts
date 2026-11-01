import { describe, expect, it } from 'vitest';
import { createLoreCardModel, createNodeDetailModel, createNodeTooltipModel, gradientKeyForNode, isGraphSnapshot, NODE_GRADIENTS, nodeLabelOffsetY, nodeVisualStyle, reconcileGraph, selectVisibleGraph, shortNodeLabel } from '../src/overlay/view-model.js';
import type { GraphSnapshot } from '../src/graph/types.js';
import { curvedEdgePath, mergeLayoutPoints, neighborIds, type LayoutPoint } from '../src/overlay/geometry.js';
import { connectedComponents, edgeEndpointId, fibonacciSphere, globeNodeIds, globeRadiusForViewport, globeVisibleEdges, largeComponentIds, projectSphere } from '../src/overlay/globe.js';

const node = (id: string, title = id, status: 'unconfirmed' | 'canon' | 'superseded' = 'unconfirmed', created = '2026-10-29T00:00:00.000Z') => ({
  id, type: 'stone', title, status, relativePath: `stones/${id}.md`, path: `stones/${id}.md`, created, author: 'Viewer',
});
const snapshot = (revision: number, nodes = [node('st_a1b2c3')], edges: GraphSnapshot['edges'] = []): GraphSnapshot => ({
  version: 1, protocolVersion: 1, revision, generatedAt: '2026-10-29T00:00:00.000Z', nodes, edges, diagnostics: [],
});

describe('overlay view model', () => {
  it('maps types and statuses to distinct visual styles', () => {
    expect(nodeVisualStyle(node('st_a1b2c3'))).toMatchObject({ shape: 'circle', fillMode: 'gradient', outlineStyle: 'solid', opacity: 1 });
    expect(nodeVisualStyle({ ...node('lore-1'), type: 'lore', status: 'canon' })).toMatchObject({ shape: 'circle', fillMode: 'solid', outlineStyle: 'solid' });
    expect(nodeVisualStyle({ ...node('person-1'), type: 'person', status: 'active' })).toMatchObject({ shape: 'circle', fillMode: 'gradient' });
    expect(nodeVisualStyle({ ...node('stream-1'), type: 'stream', status: 'completed' })).toMatchObject({ shape: 'circle', fillMode: 'gradient' });
    expect(nodeVisualStyle({ ...node('loop-1'), type: 'loop', status: 'open' })).toMatchObject({ shape: 'circle', fillMode: 'gradient' });
    expect(gradientKeyForNode({ ...node('stream-1'), type: 'stream' })).toBe('white');
    expect(nodeVisualStyle(node('old-1', 'Old', 'superseded'))).toMatchObject({ opacity: 0.35, outlineStyle: 'solid' });
  });

  it('derives concise labels without changing authoritative titles', () => {
    const title = 'The community remember the Kevin rename as failed speedrun meme';
    expect(shortNodeLabel(title).split(' ')).toHaveLength(2);
    expect(shortNodeLabel(title)).toBe('Kevin Rename');
    expect(node('st_a1b2c3', title).title).toBe(title);
  });

  it('assigns stable gradients and exposes only available detail metadata', () => {
    const first = { ...node('st_a1b2c3', 'Kevin'), body: 'A remembered moment.', source: [{ msg_id: 'msg-1', ts: '2026-10-29T00:00:00.000Z' }], history: [{ type: 'canonized' as const, at: '2026-10-30T00:00:00.000Z' }] };
    expect(gradientKeyForNode(first)).toBe(gradientKeyForNode({ ...first }));
    expect(createNodeTooltipModel(first)).toMatchObject({ title: 'Kevin', preview: 'A remembered moment.', status: 'unconfirmed' });
    expect(createNodeDetailModel(first, [{ id: 'st_d4e5f6', title: 'Story' }])).toMatchObject({ id: 'st_a1b2c3', body: 'A remembered moment.', history: [{ type: 'canonized' }], related: [{ title: 'Story' }] });
  });

  it('retains safe, Markdown-derived person and stream inspector details', () => {
    const person = { ...node(`pe_${'a'.repeat(64)}`, 'Viewer', 'unconfirmed'), type: 'person' as const, status: 'active' as const, author: '', created: '', contributedStoneCount: 2 };
    const stream = { ...node(`sr_${'b'.repeat(64)}`, 'Stream session', 'unconfirmed'), type: 'stream' as const, status: 'interrupted' as const, author: '', created: '2026-11-01T10:00:00.000Z', ended: undefined, recoveryObservedAt: '2026-11-01T11:00:00.000Z' };
    expect(createNodeDetailModel(person, [])).toMatchObject({ title: 'Viewer', contributedStoneCount: 2 });
    expect(createNodeDetailModel(stream, [])).toMatchObject({ status: 'interrupted', created: '2026-11-01T10:00:00.000Z', recoveryObservedAt: '2026-11-01T11:00:00.000Z' });
    expect(createNodeDetailModel(stream, []).ended).toBeUndefined();
  });

  it('uses deterministic varied colours and puts compact labels beneath every node', () => {
    expect(NODE_GRADIENTS).toEqual(['red', 'yellow', 'blue', 'purple', 'green', 'orange', 'maroon', 'brown']);
    const colours = new Set(Array.from({ length: 80 }, (_, index) => gradientKeyForNode(node(`st_palette_${index}`))));
    expect(colours.size).toBeGreaterThanOrEqual(6);
    expect(gradientKeyForNode(node('st_palette_1'))).toBe(gradientKeyForNode(node('st_palette_1')));
    expect(nodeLabelOffsetY(13)).toBe(29);
    expect(nodeLabelOffsetY(14)).toBe(30);
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

  it('reuses layout object identity and coordinates for stable IDs', () => {
    const existing: (LayoutPoint & { title?: string })[] = [{ id: 'st_a1b2c3', x: 120, y: 80 }];
    const updated = mergeLayoutPoints(existing, [{ id: 'st_a1b2c3', title: 'Updated' }], { x: 500, y: 400 });
    expect(updated[0]).toBe(existing[0]);
    expect(updated[0]).toMatchObject({ x: 120, y: 80, title: 'Updated' });
    const added = mergeLayoutPoints(updated, [{ id: 'st_a1b2c3' }, { id: 'st_d4e5f6' }], { x: 500, y: 400 });
    expect(added[1]).toMatchObject({ id: 'st_d4e5f6', x: 500, y: 400 });
  });

  it('produces deterministic curved paths and neighbor highlighting sets', () => {
    const edge = { id: 'edge-1', source: 'st_a1b2c3', target: 'st_d4e5f6', type: 'wikilink' as const };
    expect(curvedEdgePath(edge, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(curvedEdgePath(edge, { x: 0, y: 0 }, { x: 100, y: 0 }));
    expect(curvedEdgePath(edge, { x: 0, y: 0 }, { x: 100, y: 0 })).toContain('Q');
    expect(neighborIds([edge], 'st_a1b2c3')).toEqual(new Set(['st_d4e5f6']));
    expect(neighborIds([edge], null)).toEqual(new Set());
  });

  it('retains the legacy component helper behavior when given an explicit threshold', () => {
    const make = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
    const chain = (nodes: { id: string }[]) => nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id }));
    const twentyFive = make(25, 'a');
    expect(largeComponentIds(twentyFive, chain(twentyFive), 26)).toEqual(new Set());
    const twentySix = make(26, 'b');
    expect(largeComponentIds(twentySix, chain(twentySix), 26).size).toBe(26);
  });

  it('does not count isolated or unrelated components toward globe activation', () => {
    const large = Array.from({ length: 26 }, (_, index) => ({ id: `large-${index}` }));
    const small = Array.from({ length: 25 }, (_, index) => ({ id: `small-${index}` }));
    const edges = large.slice(1).map((node, index) => ({ source: large[index].id, target: node.id }));
    const active = largeComponentIds([...large, ...small, { id: 'isolated' }], edges, 26);
    expect(active.size).toBe(26);
    expect(active.has('small-0')).toBe(false);
  });

  it('uses total visible nodes for globe mode, including disconnected notes', () => {
    const nodes24 = Array.from({ length: 24 }, (_, index) => ({ id: `n-${index}` }));
    const nodes25 = Array.from({ length: 25 }, (_, index) => ({ id: `n-${index}` }));
    const nodes26 = Array.from({ length: 26 }, (_, index) => ({ id: `n-${index}` }));
    const nodes32 = Array.from({ length: 32 }, (_, index) => ({ id: `n-${index}` }));
    expect(globeNodeIds(nodes24)).toEqual(new Set());
    expect(globeNodeIds(nodes25)).toEqual(new Set());
    expect(globeNodeIds(nodes26)).toEqual(new Set(nodes26.map((entry) => entry.id)));
    expect(globeNodeIds(Array.from({ length: 27 }, (_, index) => ({ id: `n-${index}` })))).toHaveLength(27);
    expect(globeNodeIds(nodes32).size).toBe(32);
    expect(fibonacciSphere([...globeNodeIds(nodes26)]).map((point) => point.id)).toHaveLength(26);
    // Removing the 26th active node returns immediately to force mode.
    expect(globeNodeIds(nodes26.slice(0, 25))).toEqual(new Set());
  });

  it('hides globe edges by default and shows only selected or dragged real relationships', () => {
    const edges = [
      { id: 'ab', source: 'a', target: 'b', type: 'wikilink' as const },
      { id: 'bc', source: 'b', target: 'c', type: 'wikilink' as const },
      { id: 'de', source: 'd', target: 'e', type: 'wikilink' as const },
    ];
    expect(globeVisibleEdges(edges, true, null, null)).toEqual([]);
    expect(globeVisibleEdges(edges, true, 'b', null).map((edge) => edge.id)).toEqual(['ab', 'bc']);
    expect(globeVisibleEdges(edges, true, null, 'd').map((edge) => edge.id)).toEqual(['de']);
    expect(globeVisibleEdges(edges, false, null, null)).toEqual(edges);
  });

  it('creates stable evenly distributed sphere coordinates and preserves radius under rotation', () => {
    const ids = ['st_c', 'st_a', 'st_b'];
    const first = fibonacciSphere(ids);
    expect(fibonacciSphere([...ids].reverse())).toEqual(first);
    const projected = projectSphere(first[0], { x: 100, y: 80 }, 50, Math.PI / 3);
    expect(Math.hypot(projected.x - 100, projected.y - 80)).toBeLessThanOrEqual(50.001);
    expect(connectedComponents([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'missing' }])).toEqual([['a'], ['b']]);
    expect(globeRadiusForViewport(1920, 1080)).toBeGreaterThan(400);
    expect(globeRadiusForViewport(1280, 720)).toBeGreaterThan(250);
    expect(edgeEndpointId('st_a1b2c3')).toBe('st_a1b2c3');
    expect(edgeEndpointId({ id: 'st_d4e5f6' })).toBe('st_d4e5f6');
  });
});
