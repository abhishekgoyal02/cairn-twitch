import { createServer, type Server as HttpServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GraphSnapshot } from './types.js';
import { GraphService } from './service.js';

export interface GraphServerOptions {
  graph: GraphService;
  host?: string;
  port?: number;
  overlayPath?: string;
}

export class GraphServer {
  private readonly graph: GraphService;
  private readonly host: string;
  private readonly port: number;
  private readonly overlayPath: string;
  private readonly clients = new Set<WebSocket>();
  private readonly server: HttpServer;
  private readonly sockets: WebSocketServer;
  private unsubscribe?: () => void;
  private lastGraphRevision = -1;
  private started = false;

  constructor(options: GraphServerOptions) {
    this.graph = options.graph;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 8787;
    this.overlayPath = options.overlayPath ?? path.resolve(process.cwd(), 'public', 'overlay.html');
    this.lastGraphRevision = this.graph.getSnapshot().revision;
    this.server = createServer((request, response) => {
      void this.handleHttp(request.method ?? 'GET', request.url ?? '/', response);
    });
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/ws') { socket.destroy(); return; }
      this.sockets.handleUpgrade(request, socket, head, (client) => this.sockets.emit('connection', client, request));
    });
    this.sockets.on('connection', (client) => {
      this.clients.add(client);
      client.on('error', () => this.clients.delete(client));
      client.on('close', () => this.clients.delete(client));
      this.send(client, this.graph.getSnapshot());
    });
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.lastGraphRevision = this.graph.getSnapshot().revision;
    this.unsubscribe = this.graph.subscribe((snapshot) => this.broadcast(snapshot));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { this.server.off('listening', onListening); reject(error); };
      const onListening = (): void => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    this.started = true;
  }

  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.sockets.close();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  public getAddress(): { host: string; port: number } {
    const address = this.server.address();
    if (!address || typeof address === 'string') return { host: this.host, port: this.port };
    return { host: address.address, port: address.port };
  }

  public publish(event: object): void {
    if (!isPublishableEvent(event, this.lastGraphRevision)) return;
    if (isGraphEvent(event)) this.lastGraphRevision = event.revision;
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload, 'utf8') > 1024 * 1024) return;
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try { client.send(payload); } catch { this.clients.delete(client); client.close(); }
      }
    }
  }

  private broadcast(snapshot: GraphSnapshot): void {
    if (!isValidGraphSnapshot(snapshot) || snapshot.revision <= this.lastGraphRevision) return;
    this.lastGraphRevision = snapshot.revision;
    for (const client of this.clients) this.send(client, snapshot);
  }

  private send(client: WebSocket, snapshot: GraphSnapshot): void {
    if (client.readyState === 1) {
      try { client.send(JSON.stringify({ protocolVersion: 1, type: 'graph.updated', revision: snapshot.revision, graph: snapshot })); }
      catch { this.clients.delete(client); client.close(); }
    }
  }

  private async handleHttp(method: string, rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      return this.json(response, 405, { error: 'method not allowed' });
    }
    let pathname: string;
    try {
      pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
    } catch {
      return this.json(response, 400, { error: 'invalid request target' });
    }
    pathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    if (pathname === '/api/health') return this.json(response, 200, { ok: true });
    if (pathname === '/api/ready') return this.json(response, 200, { ready: this.graph.isReady() });
    if (pathname === '/api/graph') return this.json(response, 200, this.graph.getSnapshot());
    if (pathname === '/d3.bundle.js') return this.staticFile(response, path.join(path.dirname(this.overlayPath), 'd3.bundle.js'), 'text/javascript; charset=utf-8');
    if (pathname === '/' || pathname === '/overlay.html') {
      try {
        const html = await fs.readFile(this.overlayPath, 'utf8');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(method === 'HEAD' ? undefined : html);
      } catch {
        this.json(response, 404, { error: 'overlay not found' });
      }
      return;
    }
    this.json(response, 404, { error: 'not found' });
  }

  private async staticFile(response: import('node:http').ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath);
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
      response.end(content);
    } catch {
      this.json(response, 404, { error: 'asset not found' });
    }
  }

  private json(response: import('node:http').ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  }
}

function isGraphEvent(event: object): event is { protocolVersion: 1; type: 'graph.updated'; revision: number; graph: GraphSnapshot } {
  const candidate = event as Partial<{ protocolVersion: number; type: string; revision: number; graph: GraphSnapshot }>;
  return candidate.protocolVersion === 1 && candidate.type === 'graph.updated' && Number.isInteger(candidate.revision) &&
    candidate.graph !== undefined && isValidGraphSnapshot(candidate.graph) && candidate.graph.revision === candidate.revision;
}

function isValidGraphSnapshot(snapshot: GraphSnapshot): boolean {
  return snapshot.version === 1 && snapshot.protocolVersion === 1 && Number.isInteger(snapshot.revision) && snapshot.revision >= 0 &&
    Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges) &&
    snapshot.nodes.every((node) => typeof node.id === 'string' && typeof node.type === 'string' && typeof node.title === 'string' && typeof node.status === 'string') &&
    snapshot.edges.every((edge) => typeof edge.id === 'string' && typeof edge.source === 'string' && typeof edge.target === 'string' && edge.type === 'wikilink');
}

function isPublishableEvent(event: object, lastGraphRevision: number): boolean {
  if (isGraphEvent(event)) return event.revision > lastGraphRevision;
  const candidate = event as Partial<{ protocolVersion: number; type: string; revision: number; card: { topic: string; answer: string; title: string; noteId: string; status: string } }>;
  if (candidate.protocolVersion !== 1 || candidate.type !== 'lore.card' || typeof candidate.revision !== 'number' || !Number.isInteger(candidate.revision) || candidate.revision < 0 || !candidate.card) return false;
  const { topic, answer, title, noteId, status } = candidate.card;
  return [topic, answer, title, noteId, status].every((value) => typeof value === 'string' && value.length <= 4000);
}
