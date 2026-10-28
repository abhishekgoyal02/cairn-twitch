import 'dotenv/config';
import path from 'node:path';

export interface AppConfig {
  twitchClientId: string;
  twitchAccessToken: string;
  twitchBotUsername: string;
  twitchChannel: string;
  vaultPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function resolveVaultPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(process.cwd(), env.CAIRN_VAULT_PATH?.trim() || 'cairn-vault');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required: Array<[string, string | undefined]> = [
    ['TWITCH_CLIENT_ID', env.TWITCH_CLIENT_ID],
    ['TWITCH_ACCESS_TOKEN', env.TWITCH_ACCESS_TOKEN],
    ['TWITCH_BOT_USERNAME', env.TWITCH_BOT_USERNAME],
    ['TWITCH_CHANNEL', env.TWITCH_CHANNEL],
  ];

  const missing = required
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required Twitch configuration: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and set values locally.',
    );
  }

  return {
    twitchClientId: env.TWITCH_CLIENT_ID!.trim(),
    twitchAccessToken: env.TWITCH_ACCESS_TOKEN!.trim(),
    twitchBotUsername: env.TWITCH_BOT_USERNAME!.trim().toLowerCase(),
    twitchChannel: env.TWITCH_CHANNEL!.trim().replace(/^#/, '').toLowerCase(),
    vaultPath: resolveVaultPath(env),
  };
}
