import { StaticAuthProvider } from '@twurple/auth';
import { ChatClient, type ChatMessage } from '@twurple/chat';
import type { AppConfig } from '../config.js';
import { normalizeMessage } from '../chat/normalize-message.js';
import { MessageProcessor } from '../chat/process-message.js';

export function createTwitchClient(
  config: AppConfig,
  processor: MessageProcessor,
): ChatClient {
  const authProvider = new StaticAuthProvider(
    config.twitchClientId,
    config.twitchAccessToken,
  );

  const chatClient = new ChatClient({
    authProvider,
    channels: [config.twitchChannel],
    rejoinChannelsOnReconnect: true,
  });

  chatClient.onMessage(async (channel, user, text, message: ChatMessage) => {
    const startsWithCommand = text.trimStart().startsWith('!');
    console.log(
      `Incoming chat message: channel=#${channel}, sender=${user}, startsWithCommand=${startsWithCommand}.`,
    );

    try {
      await processor.process(normalizeMessage(channel, user, text, message));
    } catch {
      console.error(`Chat message processing failed for #${channel} from ${user}.`);
    }
  });

  chatClient.onAuthenticationSuccess(() => {
    console.log(`Twitch authentication succeeded as ${config.twitchBotUsername}.`);
  });

  chatClient.onJoin((channel, user) => {
    console.log(`Twitch channel join succeeded: #${channel} as ${user}.`);
  });

  chatClient.onJoinFailure((channel, reason) => {
    console.error(`Twitch channel join failed: #${channel}; reason=${reason}.`);
  });

  chatClient.onAuthenticationFailure((error) => {
    void error;
    console.error(
      'Twitch authentication failed. Check the bot token scopes and channel authorization.',
    );
  });

  chatClient.onDisconnect((manually, reason) => {
    if (!manually) {
      console.error(`Twitch chat disconnected: ${reason ?? 'unknown reason'}`);
    }
  });

  return chatClient;
}
