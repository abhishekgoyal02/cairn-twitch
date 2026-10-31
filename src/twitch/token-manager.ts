import { RefreshingAuthProvider, type AccessToken, type AccessTokenWithUserId } from '@twurple/auth';
import type { UserIdResolvable } from '@twurple/common';
import type { AppConfig } from '../config.js';
import { tokenStoreFromConfig, type StoredTwitchToken, type TokenStore } from './token-store.js';

export type TokenSource = 'persisted' | 'bootstrap';

/** The single lifecycle boundary for Twitch user credentials. */
export class TwitchTokenManager {
  public readonly store: TokenStore;
  public readonly initial?: StoredTwitchToken;
  public readonly source: TokenSource | 'missing';
  public readonly bootstrapSuperseded: boolean;
  private pending = Promise.resolve();
  private queuedFingerprint?: string;

  constructor(private readonly config: AppConfig) {
    const loaded = tokenStoreFromConfig(config);
    this.store = loaded.store;
    this.initial = loaded.initial;
    this.source = loaded.source;
    this.bootstrapSuperseded = loaded.source === 'persisted' && !!config.twitchAccessToken && !!config.twitchRefreshToken && !!loaded.initial && (loaded.initial.accessToken !== config.twitchAccessToken || loaded.initial.refreshToken !== config.twitchRefreshToken);
  }

  public createProvider(log: (message: string) => void): RefreshingAuthProvider {
    const manager = this;
    class CoordinatedProvider extends RefreshingAuthProvider {
      public override async refreshAccessTokenForUser(user: UserIdResolvable): Promise<AccessTokenWithUserId> {
        return manager.store.withRotationLock(async () => {
          const userId = typeof user === 'string' ? user : (user as { id?: string }).id ?? String(user);
          const latest = manager.store.load();
          if (latest?.refreshToken) this.addUser(userId, latest, this.getIntentsForUser(userId));
          const refreshed = await super.refreshAccessTokenForUser(userId);
          await manager.store.save({ ...refreshed, userId, username: manager.config.twitchBotUsername });
          return refreshed;
        });
      }
    }
    const provider = new CoordinatedProvider({ clientId: this.config.twitchClientId, clientSecret: this.config.twitchClientSecret });
    provider.onRefresh((userId, token: AccessToken) => {
      const persisted: StoredTwitchToken = { ...token, userId, username: this.config.twitchBotUsername };
      this.persist(persisted)
        .then(() => log('Twitch authentication diagnostics: refresh persistence=succeeded.'))
        .catch(() => log('Twitch authentication diagnostics: refresh persistence=failed.'));
    });
    provider.onRefreshFailure((userId, error) => {
      void error;
      log(`Twitch authentication diagnostics: refresh attempted=true outcome=failed user=${userId}.`);
    });
    return provider;
  }

  public persist(token: StoredTwitchToken): Promise<void> {
    const fingerprint = `${token.accessToken}\u0000${token.refreshToken}\u0000${token.obtainmentTimestamp}`;
    if (fingerprint === this.queuedFingerprint) return this.pending;
    this.queuedFingerprint = fingerprint;
    this.pending = this.pending.catch(() => undefined).then(() => this.store.save(token));
    return this.pending;
  }

  public async flush(): Promise<void> {
    await this.pending;
    await this.store.flush();
  }

  /** Refresh under the token-file lock, then durably persist both rotated values. */
  public async forceRefresh(provider: RefreshingAuthProvider, userId: string): Promise<AccessTokenWithUserId> {
    const refreshed = await provider.refreshAccessTokenForUser(userId);
    await this.flush();
    return refreshed;
  }
}
