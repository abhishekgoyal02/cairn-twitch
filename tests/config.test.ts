import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  TWITCH_CLIENT_ID: 'client-id',
  TWITCH_ACCESS_TOKEN: 'secret-access-token',
  TWITCH_BOT_USERNAME: 'CairnBot',
  TWITCH_CHANNEL: '#CairnChannel',
};

describe('loadConfig', () => {
  it('loads and normalizes the required configuration', () => {
    expect(loadConfig(validEnv)).toEqual({
      twitchClientId: 'client-id',
      twitchAccessToken: 'secret-access-token',
      twitchBotUsername: 'cairnbot',
      twitchChannel: 'cairnchannel',
      vaultPath: 'D:\\TwitchCon-Hackathon\\cairn-twitch\\cairn-vault',
    });
  });

  it('reports missing variables without exposing secret values', () => {
    expect(() => loadConfig({ TWITCH_CLIENT_ID: 'client-id' })).toThrow(ConfigError);
    expect(() => loadConfig({ TWITCH_CLIENT_ID: 'client-id' })).toThrow(/TWITCH_ACCESS_TOKEN/);
    let errorMessage = '';
    try {
      loadConfig({ TWITCH_ACCESS_TOKEN: 'super-secret' });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toMatch(/TWITCH_CLIENT_ID/);
    expect(errorMessage.includes('super-secret')).toBe(false);
  });
});
