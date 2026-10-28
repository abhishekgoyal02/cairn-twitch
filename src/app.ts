import { loadConfig } from './config.js';
import { MessageProcessor } from './chat/process-message.js';
import { createTwitchClient } from './twitch/client.js';
import { StoneService } from './chat/stone-service.js';
import { WhyService } from './chat/why-service.js';
import { SqliteIndex } from './index/sqlite-index.js';
import path from 'node:path';
import { GraphService } from './graph/service.js';
import { GraphServer } from './graph/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  let twitchClient: ReturnType<typeof createTwitchClient> | undefined;
  const index = new SqliteIndex(path.join(config.vaultPath, '.cairn', 'index.sqlite'), config.vaultPath);
  const stoneService = new StoneService({ vaultPath: config.vaultPath, index });
  const graphService = new GraphService({
    vaultPath: config.vaultPath,
    index,
    log: (message) => console.error(message),
  });
  await graphService.start();
  const graphServer = new GraphServer({ graph: graphService });
  await graphServer.start();
  const address = graphServer.getAddress();
  console.log(`Cairn graph ready at http://${address.host}:${address.port}/overlay.html`);
  const whyService = new WhyService({
    vaultPath: config.vaultPath,
    index,
    log: (message) => console.error(message),
    onCard: (card) => graphServer.publish({
      protocolVersion: 1,
      type: 'lore.card',
      revision: graphService.getSnapshot().revision,
      card,
    }),
  });

  const processor = new MessageProcessor({
    botUsername: config.twitchBotUsername,
    reply: (channel, text) => twitchClient?.say(channel, text),
    log: (message) => console.log(message),
    stone: (message, body) => stoneService.create(message, body),
    why: (topic) => whyService.answer(topic),
  });

  twitchClient = createTwitchClient(config, processor);
  twitchClient.onConnect(() => {
    console.log('Connected to Twitch chat transport.');
  });

  const shutdown = (): void => {
    twitchClient?.quit();
    void (async () => {
      await graphServer.stop();
      await graphService.stop();
      stoneService.close();
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  twitchClient.connect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`Cairn failed to start: ${message}`);
  process.exitCode = 1;
});
