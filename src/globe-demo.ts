import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphServer } from './graph/server.js';
import { GraphService } from './graph/service.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { serializeStone, type StoneNote } from './vault/stone-schema.js';

const PORT = 8788;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-globe-demo-'));
const stones = path.join(root, 'stones');
await fs.mkdir(stones, { recursive: true });

for (let index = 0; index < 26; index += 1) {
  const id = `st_${String(index).padStart(6, '0')}`;
  const note: StoneNote = {
    frontmatter: {
      id,
      type: 'stone',
      title: `Demo Memory ${index + 1}`,
      status: index % 5 === 0 ? 'canon' : 'unconfirmed',
      created: '2026-10-29T00:00:00.000Z',
      author: 'Cairn Globe Demo',
      source: [{ msg_id: `demo-globe-${index}`, ts: '2026-10-29T00:00:00.000Z', author: 'Cairn Globe Demo' }],
    },
    body: `Temporary development memory ${index + 1} linked to [[Demo Memory ${(index + 25) % 26 + 1}]] and [[Demo Memory ${(index + 1) % 26 + 1}]].`,
  };
  await fs.writeFile(path.join(stones, `${id}.md`), serializeStone(note), 'utf8');
}

const indexPath = path.join(root, '.cairn', 'index.sqlite');
const index = new SqliteIndex(indexPath, root);
const graph = new GraphService({ vaultPath: root, index });
const server = new GraphServer({ graph, port: PORT, overlayPath: path.resolve(process.cwd(), 'public', 'overlay.html') });

const cleanup = async (): Promise<void> => {
  await server.stop();
  await graph.stop();
  index.close();
  await fs.rm(root, { recursive: true, force: true });
};

process.once('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });

try {
  await graph.start();
  const snapshot = graph.getSnapshot();
  if (snapshot.nodes.length !== 26 || snapshot.edges.length !== 52) {
    throw new Error(`Demo fixture integrity check failed: ${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges`);
  }
  await server.start();
  console.log(`Cairn globe demo ready: http://127.0.0.1:${PORT}/overlay.html?demo=globe`);
  console.log(`Fixture verified: ${snapshot.nodes.length} nodes, ${snapshot.edges.length} real wikilink edges (two real neighbors per node)`);
  console.log('Temporary fixture is outside cairn-vault and will be removed on shutdown.');
} catch (error) {
  await cleanup();
  throw error;
}

