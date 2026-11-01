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
import { RecapService } from './chat/recap-service.js';
import { MyStonesService } from './chat/mystones-service.js';
import { LoopService } from './chat/loop-service.js';
import { StreamService } from './chat/stream-service.js';
import { StreamNoteRepository } from './vault/stream-repository.js';
import { StoneVaultWriter } from './vault/writer.js';
import { TwurpleStreamEventSource } from './twitch/stream-eventsub.js';
import { getTwitchAuthContext } from './twitch/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Cairn vault path: ${config.vaultPath}`);
  let twitchClient: Awaited<ReturnType<typeof createTwitchClient>> | undefined;
  let streamEvents: TwurpleStreamEventSource | undefined;
  let streamService: StreamService | undefined;
  const index = new SqliteIndex(path.join(config.vaultPath, '.cairn', 'index.sqlite'), config.vaultPath);
  const llm = new SafeLlmAdapter({ provider: config.llmProvider, endpoint: config.llmEndpoint, apiKey: config.llmApiKey, model: config.llmModel, fallbackModel: config.llmFallbackModel, log: (message) => console.error(message) });
  const streamContext = { streamIdFor: async (message: Parameters<NonNullable<import('./chat/stream-context.js').ActiveStreamProvider['streamIdFor']>>[0]) => streamService ? streamService.streamIdFor(message) : undefined };
  const stoneService = new StoneService({ vaultPath: config.vaultPath, index, llm, streamContext });
  const governance = new GovernanceService({ vaultPath: config.vaultPath, index, log: (message) => console.error(message) });
  const recapService = new RecapService({ vaultPath: config.vaultPath });
  const myStonesService = new MyStonesService({ vaultPath: config.vaultPath, log: (message) => console.error(message) });
  const loopService = new LoopService({ vaultPath: config.vaultPath, index, log: (message) => console.error(message) });
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
    recap: (message) => recapService.recap(message),
    mystones: (message) => myStonesService.list(message),
    promise: (message, args) => loopService.promise(message, args, message.isModerator || message.isBroadcaster),
    done: (message, args) => loopService.done(message, args.split(/\s+/u)[0] ?? '', message.isModerator || message.isBroadcaster),
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
    // EventSub is intentionally degraded-mode: its failure never prevents
    // chat, vault persistence, or the existing overlay from running.
    const auth = getTwitchAuthContext(twitchClient);
    if (auth) {
      let lifecycle: StreamService | undefined;
      streamEvents = new TwurpleStreamEventSource(auth.authProvider, config.twitchChannel, {
        online: async (event) => lifecycle?.onOnline(event),
        offline: async (event) => lifecycle?.onOffline(event),
      }, (message) => console.error(message));
      try {
        const broadcasterId = await streamEvents.resolveBroadcaster();
        lifecycle = new StreamService({ vaultPath: config.vaultPath, broadcasterId, streams: new StreamNoteRepository(new StoneVaultWriter(config.vaultPath)), index, log: (message) => console.error(message) });
        streamService = lifecycle;
        await lifecycle.reconcile(await streamEvents.getLiveStream());
        await streamEvents.start();
        console.log('Stream lifecycle diagnostics: outcome=ready.');
      } catch {
        console.error('Stream lifecycle diagnostics: outcome=degraded. Chat and vault features remain available.');
        await streamEvents?.stop().catch(() => undefined);
        streamEvents = undefined;
      }
    }
  } catch (error) {
    twitchClient?.quit();
    await streamEvents?.stop().catch(() => undefined);
    await graphServer?.stop().catch(() => undefined);
    await graphService.stop().catch(() => undefined);
    stoneService.close();
    throw error;
  }

  const shutdown = (): void => {
    twitchClient?.quit();
    void (async () => {
      await flushTwitchTokenPersistence(twitchClient);
      await streamEvents?.stop().catch(() => undefined);
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
