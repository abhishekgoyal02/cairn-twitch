import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

export interface AppConfig {
  twitchClientId: string;
  twitchClientSecret: string;
  twitchAccessToken?: string;
  twitchRefreshToken?: string;
  twitchAccessTokenExpiresIn?: number;
  twitchTokenObtainmentTimestamp?: number;
  twitchUserId?: string;
  twitchTokenFile: string;
  twitchBotUsername: string;
  twitchChannel: string;
  vaultPath: string;
  llmEndpoint?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmFallbackModel?: string;
  llmProvider?: 'groq' | 'ollama' | 'custom';
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
  const twitchTokenFile = path.resolve(process.cwd(), env.TWITCH_TOKEN_FILE?.trim() || '.cairn/twitch-token.json');
  const required: Array<[string, string | undefined]> = [
    ['TWITCH_CLIENT_ID', env.TWITCH_CLIENT_ID],
    ['TWITCH_CLIENT_SECRET', env.TWITCH_CLIENT_SECRET],
    ...(!env.TWITCH_ACCESS_TOKEN?.trim() && !fs.existsSync(twitchTokenFile) ? [['TWITCH_ACCESS_TOKEN', undefined] as [string, string | undefined]] : []),
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
  if (!env.TWITCH_ACCESS_TOKEN?.trim() && !fs.existsSync(twitchTokenFile)) {
    throw new ConfigError('Missing Twitch credentials: set TWITCH_ACCESS_TOKEN and TWITCH_REFRESH_TOKEN once, or create the local token store.');
  }
  if (env.TWITCH_ACCESS_TOKEN?.trim() && !env.TWITCH_REFRESH_TOKEN?.trim() && !fs.existsSync(twitchTokenFile)) {
    throw new ConfigError('Missing TWITCH_REFRESH_TOKEN for automatic Twitch token refresh.');
  }

  const llmProviderValue = env.CAIRN_LLM_PROVIDER?.trim();
  if (llmProviderValue && !['groq', 'ollama', 'custom'].includes(llmProviderValue)) {
    throw new ConfigError('CAIRN_LLM_PROVIDER must be groq, ollama, or custom.');
  }

  return {
    twitchClientId: env.TWITCH_CLIENT_ID!.trim(),
    twitchClientSecret: env.TWITCH_CLIENT_SECRET!.trim(),
    twitchAccessToken: env.TWITCH_ACCESS_TOKEN?.trim() || undefined,
    twitchRefreshToken: env.TWITCH_REFRESH_TOKEN?.trim() || undefined,
    twitchAccessTokenExpiresIn: env.TWITCH_ACCESS_TOKEN_EXPIRES_IN ? Number(env.TWITCH_ACCESS_TOKEN_EXPIRES_IN) : undefined,
    twitchTokenObtainmentTimestamp: env.TWITCH_TOKEN_OBTAINMENT_TIMESTAMP ? Number(env.TWITCH_TOKEN_OBTAINMENT_TIMESTAMP) : undefined,
    twitchUserId: env.TWITCH_USER_ID?.trim() || undefined,
    twitchTokenFile,
    twitchBotUsername: env.TWITCH_BOT_USERNAME!.trim().toLowerCase(),
    twitchChannel: env.TWITCH_CHANNEL!.trim().replace(/^#/, '').toLowerCase(),
    vaultPath: resolveVaultPath(env),
    llmEndpoint: env.CAIRN_LLM_ENDPOINT?.trim() || undefined,
    llmApiKey: env.CAIRN_LLM_API_KEY?.trim() || undefined,
    llmModel: env.CAIRN_LLM_MODEL?.trim() || undefined,
    llmFallbackModel: env.CAIRN_LLM_FALLBACK_MODEL?.trim() || undefined,
    llmProvider: llmProviderValue as AppConfig['llmProvider'] | undefined,
  };
}
