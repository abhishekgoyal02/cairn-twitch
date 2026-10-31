import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GraphServer } from '../src/graph/server.js';
import { GraphService } from '../src/graph/service.js';
import { SqliteIndex } from '../src/index/sqlite-index.js';
import { StoneVaultWriter } from '../src/vault/writer.js';
import type { StoneNote } from '../src/vault/stone-schema.js';

const serverNote: StoneNote = {
  frontmatter: {
    id: 'st_a1b2c3', type: 'stone', title: 'Kevin', status: 'unconfirmed',
    created: '2026-10-28T18:42:10.000Z', author: 'Viewer',
    source: [{ msg_id: 'message-1', ts: '2026-10-28T18:42:08.000Z' }],
  },
  body: 'Kevin is the boss.',
};
import { promises as fs } from 'node:fs';
import os from 'node:os';

describe('GraphServer', () => {
  it('serves health, readiness, graph snapshots, and WebSocket snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-server-'));
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const graph = new GraphService({ vaultPath: root, index });
    const server = new GraphServer({ graph, port: 0 });
    try {
      await graph.start();
      await server.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { host, port } = server.getAddress();
      const base = `http://${host}:${port}`;
      const health = await fetch(`${base}/api/health?check=1`);
      expect(health.status).toBe(200);
      expect((await health.json()).ok).toBe(true);
      expect((await (await fetch(`http://${host}:${port}/api/ready`)).json()).ready).toBe(true);
      const graphResponse = await fetch(`${base}/api/graph/`);
      expect(graphResponse.status).toBe(200);
      expect((await graphResponse.json()).revision).toBeGreaterThan(0);
      const landingResponse = await fetch(`${base}/`);
      expect(landingResponse.status).toBe(200);
      const landing = await landingResponse.text();
      expect(landing).toContain('/assets/cairn-logo.png');
      expect(landing).toContain('id="startup"');
      expect(landing).toContain('3000');
      expect(landing).toContain('/d3.bundle.js');
      const logoResponse = await fetch(`${base}/assets/cairn-logo.png`);
      expect(logoResponse.status).toBe(200);
      expect(logoResponse.headers.get('content-type')).toContain('image/png');
      expect((await logoResponse.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
      const overlayResponse = await fetch(`${base}/overlay.html?source=obs`);
      expect(overlayResponse.status).toBe(200);
      const overlay = await overlayResponse.text();
      expect(overlay).toContain('/d3.bundle.js');
      expect(overlay).toContain('id="startup"');
      expect(overlay).toContain('id="graph-grid"');
      expect(overlay).toContain('id="brand-mark"');
      expect(overlay).toContain('id="node-search-input"');
      expect(overlay).toContain('id="type-legend"');
      const d3Response = await fetch(`${base}/d3.bundle.js`);
      expect(d3Response.status).toBe(200);
      expect(d3Response.headers.get('content-type')).toContain('javascript');
      expect((await d3Response.text()).length).toBeGreaterThan(1000);
      const socket = new WebSocket(`ws://${host}:${port}/ws`);
      const message = await new Promise<any>((resolve, reject) => {
        socket.once('message', (data) => { resolve(JSON.parse(data.toString())); socket.close(); });
        socket.once('error', reject);
      });
      expect(message.type).toBe('graph.updated');
      expect(message.graph.protocolVersion).toBe(1);
      const reconnect = new WebSocket(`ws://${host}:${port}/ws`);
      const reconnectMessage = await new Promise<any>((resolve, reject) => {
        reconnect.once('message', (data) => { resolve(JSON.parse(data.toString())); reconnect.close(); });
        reconnect.once('error', reject);
      });
      expect(reconnectMessage.type).toBe('graph.updated');
      expect(reconnectMessage.revision).toBe(message.revision);
    } finally {
      await server.stop();
      await graph.stop();
      index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('broadcasts a newer full snapshot after a graph change', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-server-update-'));
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const graph = new GraphService({ vaultPath: root, index, debounceMs: 10 });
    const server = new GraphServer({ graph, port: 0 });
    let socket: WebSocket | undefined;
    try {
      await graph.start();
      await server.start();
      const { host, port } = server.getAddress();
      socket = new WebSocket(`ws://${host}:${port}/ws`);
      const revisions: number[] = [];
      const first = new Promise<void>((resolve, reject) => {
        socket!.once('message', (data) => { revisions.push(JSON.parse(data.toString()).revision); resolve(); });
        socket!.once('error', reject);
      });
      await first;
      const second = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for graph update')), 2000);
        socket!.on('message', (data) => {
          revisions.push(JSON.parse(data.toString()).revision);
          if (revisions.length > 1) { clearTimeout(timer); resolve(); }
        });
      });
      await new StoneVaultWriter(root).writeStone(serverNote);
      await second;
      expect(revisions[1]).toBeGreaterThan(revisions[0]);
    } finally {
      socket?.close();
      await server.stop();
      await graph.stop();
      index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale, malformed, and oversized publications while accepting newer snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-server-guard-'));
    const index = new SqliteIndex(path.join(root, '.cairn', 'index.sqlite'), root);
    const graph = new GraphService({ vaultPath: root, index });
    const server = new GraphServer({ graph, port: 0 });
    let socket: WebSocket | undefined;
    try {
      await graph.start();
      await server.start();
      const { host, port } = server.getAddress();
      socket = new WebSocket(`ws://${host}:${port}/ws`);
      const first = await new Promise<any>((resolve, reject) => {
        socket!.once('message', (data) => resolve(JSON.parse(data.toString())));
        socket!.once('error', reject);
      });
      const received: any[] = [];
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
      server.publish({ protocolVersion: 1, type: 'graph.updated', revision: first.revision, graph: first.graph });
      server.publish({ protocolVersion: 1, type: 'graph.updated', revision: first.revision + 1, graph: { ...first.graph, revision: first.revision + 1 } });
      server.publish({ protocolVersion: 1, type: 'graph.updated', revision: first.revision + 2, graph: { ...first.graph, revision: first.revision + 2, nodes: 'bad' } });
      server.publish({ protocolVersion: 1, type: 'lore.card', revision: first.revision, card: { topic: 'Kevin', answer: 'Grounded.', title: 'Kevin', noteId: 'st_a1b2c3', status: 'unconfirmed' } });
      server.publish({ protocolVersion: 1, type: 'lore.card', revision: first.revision, card: { topic: 'x'.repeat(2_000_000), answer: 'x', title: 'x', noteId: 'st_a1b2c3', status: 'unconfirmed' } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(2);
      expect(received.filter((event) => event.type === 'graph.updated')[0].revision).toBe(first.revision + 1);
      expect(received.filter((event) => event.type === 'lore.card')).toHaveLength(1);
    } finally {
      socket?.close();
      await server.stop();
      await graph.stop();
      index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
