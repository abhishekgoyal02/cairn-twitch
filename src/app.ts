import { loadConfig } from './config.js';
import { MessageProcessor } from './chat/process-message.js';
import { createTwitchClient, flushTwitchTokenPersistence } from './twitch/client.js';
import { StoneService } from './chat/stone-service.js';
import { WhyService } from './chat/why-service.js';
import { SqliteIndex } from './index/sqlite-index.js';
import path from 'node:path';
import { GraphService } from './graph/service.js';
import { GraphServer } from './graph/server.js';
import { GovernanceService } from './chat/governance-service.js';
import { SafeLlmAdapter } from './intelligence/llm.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Cairn vault path: ${config.vaultPath}`);
  let twitchClient: Awaited<ReturnType<typeof createTwitchClient>> | undefined;
  const index = new SqliteIndex(path.join(config.vaultPath, '.cairn', 'index.sqlite'), config.vaultPath);
  const llm = new SafeLlmAdapter({ provider: config.llmProvider, endpoint: config.llmEndpoint, apiKey: config.llmApiKey, model: config.llmModel, fallbackModel: config.llmFallbackModel, log: (message) => console.error(message) });
  const stoneService = new StoneService({ vaultPath: config.vaultPath, index, llm });
  const governance = new GovernanceService({ vaultPath: config.vaultPath, index, log: (message) => console.error(message) });
  const graphService = new GraphService({
    vaultPath: config.vaultPath,
    index,
    log: (message) => console.error(message),
  });
  let graphServer: GraphServer | undefined;
  const whyService = new WhyService({
    vaultPath: config.vaultPath,
    index,
    log: (message) => console.error(message),
    onCard: (card) => graphServer?.publish({
      protocolVersion: 1,
      type: 'lore.card',
      revision: graphService.getSnapshot().revision,
      card,
    }),
    llm,
  });

  const processor = new MessageProcessor({
    botUsername: config.twitchBotUsername,
    reply: (channel, text) => twitchClient?.say(channel, text),
    log: (message) => console.log(message),
    stone: (message, body) => stoneService.create(message, body),
    why: (topic) => whyService.answer(topic),
    canon: (message, args) => governance.canon(args.split(/\s+/u)[0] ?? '', message.isModerator || message.isBroadcaster),
    correct: (message, args) => {
      const match = /^([^\s]+)\s+([\s\S]+)$/u.exec(args.trim());
      return governance.correct(match?.[1] ?? '', match?.[2] ?? '', message, message.isModerator || message.isBroadcaster);
    },
    forget: (message, args) => governance.forget(args.split(/\s+/u)[0] ?? '', message.isModerator || message.isBroadcaster),
  });

  try {
    // Authenticate before exposing the graph server. A failed Twitch bootstrap
    // therefore cannot leave a partially running Cairn process behind.
    twitchClient = await createTwitchClient(config, processor);
    await graphService.start();
    graphServer = new GraphServer({ graph: graphService });
    await graphServer.start();
    const address = graphServer.getAddress();
    console.log(`Cairn graph ready at http://${address.host}:${address.port}/overlay.html`);
    twitchClient.onConnect(() => {
      console.log('Connected to Twitch chat transport.');
    });
  } catch (error) {
    twitchClient?.quit();
    await graphServer?.stop().catch(() => undefined);
    await graphService.stop().catch(() => undefined);
    stoneService.close();
    throw error;
  }

  const shutdown = (): void => {
    twitchClient?.quit();
    void (async () => {
      await flushTwitchTokenPersistence(twitchClient);
      await graphServer?.stop();
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
