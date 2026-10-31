import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  TWITCH_CLIENT_ID: 'client-id',
  TWITCH_CLIENT_SECRET: 'client-secret',
  TWITCH_ACCESS_TOKEN: 'secret-access-token',
  TWITCH_REFRESH_TOKEN: 'secret-refresh-token',
  TWITCH_BOT_USERNAME: 'CairnBot',
  TWITCH_CHANNEL: '#CairnChannel',
};

describe('loadConfig', () => {
  it('loads and normalizes the required configuration', () => {
    expect(loadConfig(validEnv)).toEqual({
      twitchClientId: 'client-id',
      twitchClientSecret: 'client-secret',
      twitchAccessToken: 'secret-access-token',
      twitchRefreshToken: 'secret-refresh-token',
      twitchBotUsername: 'cairnbot',
      twitchChannel: 'cairnchannel',
      vaultPath: 'D:\\TwitchCon-Hackathon\\cairn-twitch\\cairn-vault',
      twitchTokenFile: 'D:\\TwitchCon-Hackathon\\cairn-twitch\\.cairn\\twitch-token.json',
      twitchAccessTokenExpiresIn: undefined,
      twitchTokenObtainmentTimestamp: undefined,
      twitchUserId: undefined,
      llmEndpoint: undefined,
      llmApiKey: undefined,
      llmModel: undefined,
      llmFallbackModel: undefined,
      llmProvider: undefined,
    });
  });

  it('reports missing variables without exposing secret values', () => {
    const missingTokenEnv = { TWITCH_CLIENT_ID: 'client-id', TWITCH_CLIENT_SECRET: 'client-secret', TWITCH_TOKEN_FILE: path.join(process.cwd(), '.cairn', 'missing-test-token.json') };
    expect(() => loadConfig(missingTokenEnv)).toThrow(ConfigError);
    expect(() => loadConfig(missingTokenEnv)).toThrow(/TWITCH_ACCESS_TOKEN/);
    let errorMessage = '';
    try {
      loadConfig({ TWITCH_ACCESS_TOKEN: 'super-secret' });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toMatch(/TWITCH_CLIENT_ID/);
    expect(errorMessage.includes('super-secret')).toBe(false);
  });

  it('requires the OAuth client secret without echoing values', () => {
    expect(() => loadConfig({
      TWITCH_CLIENT_ID: 'client-id',
      TWITCH_ACCESS_TOKEN: 'access-secret',
      TWITCH_REFRESH_TOKEN: 'refresh-secret',
      TWITCH_BOT_USERNAME: 'bot',
      TWITCH_CHANNEL: 'channel',
    })).toThrow(/TWITCH_CLIENT_SECRET/);
  });

  it('accepts Groq configuration and rejects unsupported provider values', () => {
    expect(loadConfig({ ...validEnv, CAIRN_LLM_PROVIDER: 'groq', CAIRN_LLM_API_KEY: 'provider-secret', CAIRN_LLM_MODEL: 'openai/gpt-oss-20b' })).toMatchObject({
      llmProvider: 'groq', llmApiKey: 'provider-secret', llmModel: 'openai/gpt-oss-20b',
    });
    expect(() => loadConfig({ ...validEnv, CAIRN_LLM_PROVIDER: 'unsupported-provider' })).toThrow(/groq, ollama, or custom/);
  });
});
