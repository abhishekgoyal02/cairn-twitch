import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageProcessor } from './chat/process-message.js';
import { StoneService } from './chat/stone-service.js';
import { WhyService } from './chat/why-service.js';
import { GovernanceService } from './chat/governance-service.js';
import { LoopService } from './chat/loop-service.js';
import { RecapService } from './chat/recap-service.js';
import { MyStonesService } from './chat/mystones-service.js';
import { StreamService } from './chat/stream-service.js';
import type { NormalizedChatMessage } from './chat/types.js';
import type { LlmAdapter } from './intelligence/llm.js';
import { GraphServer } from './graph/server.js';
import { GraphService } from './graph/service.js';
import { scanVault } from './graph/scanner.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { reindexVault } from './index/reindex.js';
import { lintVault } from './lint-vault.js';
import { LoopNoteRepository } from './vault/loop-repository.js';
import { StreamNoteRepository } from './vault/stream-repository.js';
import { StoneVaultWriter } from './vault/writer.js';
import type { LoreNote, StoneNote } from './vault/stone-schema.js';

const DEMO_PORT = 8789;
const START = Date.parse('2026-11-01T10:00:00.000Z');

/** Offline-only adapter: all outputs are constrained by the existing services. */
const demoLlm: LlmAdapter = {
  async suggestLinks(input) { return { ids: input.candidates.length ? [input.candidates[0].id] : [] }; },
  async suggestLore(input) { return { title: 'Demo community lore', stoneIds: input.stoneIds.slice(0, 1) }; },
  async answerWhy(input) { return { answer: `Demo evidence for ${input.question}.`, citations: input.notes.slice(0, 1).map((note) => note.id) }; },
};

export interface DemoRun {
  vaultPath: string;
  replies: string[];
  graph: GraphService;
  server: GraphServer;
  cleanup(): Promise<void>;
}

export async function runDemo(options: { port?: number; keep?: boolean } = {}): Promise<DemoRun> {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-demo-'));
  const writer = new StoneVaultWriter(vaultPath);
  const replies: string[] = [];
  let now = START;
  const index = new SqliteIndex(path.join(vaultPath, '.cairn', 'index.sqlite'), vaultPath);
  const graph = new GraphService({ vaultPath, index, debounceMs: 1 });
  const server = new GraphServer({ graph, port: options.port ?? DEMO_PORT, overlayPath: path.resolve(process.cwd(), 'public', 'overlay.html') });
  let stopped = false;
  const cleanup = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.stop().catch(() => undefined);
    await graph.stop().catch(() => undefined);
    index.close();
    if (!options.keep) await fs.rm(vaultPath, { recursive: true, force: true });
  };
  try {
    const seeded = await seedHistory(writer);
    index.upsert(seeded.seed, seeded.seedReceipt.relativePath);
    index.upsert(seeded.lore, seeded.loreReceipt.relativePath);
    const governance = new GovernanceService({ vaultPath, writer, index, idFactory: sequence(['st_d3m003']) });
    const loops = new LoopService({ vaultPath, writer, index, loops: new LoopNoteRepository(writer, sequence(['lp_d3m001', 'lp_d3m002'])) });
    const streams = new StreamService({ vaultPath, broadcasterId: 'demo-broadcaster', streams: new StreamNoteRepository(writer), index });
    const stone = new StoneService({ vaultPath, writer, index, llm: demoLlm, now: () => now, idFactory: sequence(['st_d3m001', 'st_d3m002']), streamContext: streams });
    await streams.onOnline({ broadcasterId: 'demo-broadcaster', streamId: 'demo-stream-1', startedAt: new Date(now).toISOString() });
    const processor = new MessageProcessor({
      botUsername: 'cairnbot', reply: async (_channel, text) => { replies.push(text); },
      stone: (message, body) => stone.create(message, body),
      why: (topic) => new WhyService({ vaultPath, index, llm: demoLlm }).answer(topic),
      recap: (message) => new RecapService({ vaultPath, now: () => now }).recap(message),
      mystones: (message) => new MyStonesService({ vaultPath }).list(message),
      canon: (_message, id) => governance.canon(id, true),
      correct: (message, args) => { const [id, ...text] = args.split(/\s+/u); return governance.correct(id ?? '', text.join(' '), message, true); },
      promise: (message, text) => loops.promise(message, text, true),
      done: (message, id) => loops.done(message, id, true),
    });
    const viewer = (id: string, text: string, moderator = false): NormalizedChatMessage => ({ id, channel: 'demo', sender: moderator ? 'demomod' : 'demoviewer', senderId: moderator ? 'moderator-1' : 'viewer-1', displayName: moderator ? 'Demo Moderator' : 'Demo Viewer', text, timestamp: new Date(now), isModerator: moderator, isBroadcaster: false });
    await processor.process(viewer('demo-1', '!stone Kevin is the demo boss after the speedrun.'));
    await waitFor(async () => (await writer.findStone('st_d3m001'))?.note.body.includes('Related:') ?? false);
    now += 31_000;
    await processor.process(viewer('demo-2', '!stone The community remembers the Kevin demo boss.'));
    await processor.process(viewer('demo-2', '!stone The community remembers the Kevin demo boss.')); // duplicate event
    now += 1_000;
    await processor.process(viewer('demo-3', '!why Kevin'));
    await processor.process(viewer('demo-4', '!why nonexistent galactic archive'));
    await processor.process(viewer('demo-5', '!canon st_d3m001', true));
    now += 1_000;
    await processor.process(viewer('demo-6', '!correct st_d3m001 Kevin is the confirmed demo boss.', true));
    now += 1_000;
    await processor.process(viewer('demo-7', '!promise Finish the demo challenge next stream', true));
    await processor.process(viewer('demo-8', '!done lp_d3m001', true));
    now += 1_000;
    await processor.process(viewer('demo-9', '!promise Review community vault next stream', true));
    now += 31_000;
    await processor.process(viewer('demo-10', '!mystones'));
    await processor.process(viewer('demo-11', '!recap'));
    await streams.onOffline({ broadcasterId: 'demo-broadcaster', streamId: 'demo-stream-1', occurredAt: new Date(now + 1_000).toISOString() });
    await graph.start();
    await graph.flush();
    await server.start();
    const lint = await lintVault(vaultPath);
    if (lint.errors.length) throw new Error(`Demo vault lint failed: ${lint.errors.map((error) => error.reason).join('; ')}`);
    const rebuilt = await reindexVault(vaultPath);
    if (rebuilt.invalid.length) throw new Error('Demo reindex reported invalid notes');
    const scan = await scanVault(vaultPath);
    if (!scan.notes.some((record) => record.note.frontmatter.type === 'stream') || graph.getSnapshot().nodes.length !== scan.notes.length) throw new Error('Demo graph did not match Markdown vault');
    return { vaultPath, replies, graph, server, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function seedHistory(writer: StoneVaultWriter): Promise<{ seed: StoneNote; seedReceipt: Awaited<ReturnType<StoneVaultWriter['writeStone']>>; lore: LoreNote; loreReceipt: Awaited<ReturnType<StoneVaultWriter['writeLore']>> }> {
  const seed: StoneNote = { frontmatter: { id: 'st_s3ed01', type: 'stone', title: 'Kevin origins', status: 'canon', created: '2026-11-01T09:00:00.000Z', author: 'Demo Archivist', source: [{ msg_id: 'seed-kevin', ts: '2026-11-01T09:00:00.000Z', author: 'Demo Archivist' }] }, body: 'Kevin became the community boss during a failed speedrun.' };
  const lore: LoreNote = { frontmatter: { id: 'lo_s3ed01', type: 'lore', title: 'Kevin community lore', status: 'canon', created: '2026-11-01T09:01:00.000Z', author: 'Demo Archivist' }, body: 'Related: [[st_s3ed01]]' };
  const seedReceipt = await writer.writeStone(seed);
  const loreReceipt = await writer.writeLore(lore);
  return { seed, seedReceipt, lore, loreReceipt };
}

function sequence(values: string[]): () => string { let index = 0; return () => values[Math.min(index++, values.length - 1)]; }
async function waitFor(check: () => Promise<boolean>): Promise<void> { for (let attempt = 0; attempt < 30; attempt += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Demo relationship did not settle'); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const verify = process.argv.includes('--verify');
  const demo = await runDemo({ port: verify ? 0 : DEMO_PORT });
  const address = demo.server.getAddress();
  console.log(`Cairn demo ready: http://127.0.0.1:${address.port}/overlay.html`);
  console.log('Offline temporary vault verified; no Twitch, EventSub, or LLM provider was contacted.');
  if (verify) await demo.cleanup();
  else {
    const stop = (): void => { void demo.cleanup().finally(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
