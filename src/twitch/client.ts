import { RefreshingAuthProvider, type AccessToken } from '@twurple/auth';
import { ChatClient, type ChatMessage } from '@twurple/chat';
import type { AppConfig } from '../config.js';
import { normalizeMessage } from '../chat/normalize-message.js';
import { MessageProcessor } from '../chat/process-message.js';
import { type StoredTwitchToken } from './token-store.js';
import { TwitchTokenManager } from './token-manager.js';

export class TwitchIdentityError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'TwitchIdentityError'; }
}

const tokenManagers = new WeakMap<ChatClient, TwitchTokenManager>();
const authProviders = new WeakMap<ChatClient, RefreshingAuthProvider>();
const authenticatedUserIds = new WeakMap<ChatClient, string>();

export async function createTwitchClient(
  config: AppConfig,
  processor: MessageProcessor,
): Promise<ChatClient> {
  const manager = new TwitchTokenManager(config);
  const { initial } = manager;
  if (!initial) throw new Error('No Twitch token store found. Set bootstrap access/refresh tokens, then restart Cairn.');
  console.log(`Twitch authentication diagnostics: tokenSource=${manager.source}, accessTokenLocallyExpired=${isExpired(initial)}, bootstrapSuperseded=${manager.bootstrapSuperseded}.`);
  const authProvider = manager.createProvider((message) => console.log(message));
  let userId = initial.userId;
  try {
    if (userId) {
      authProvider.addUser(userId, initial, ['chat']);
      if (!authProvider.getIntentsForUser(userId).includes('chat')) authProvider.addIntentsToUser(userId, ['chat']);
    } else userId = await authProvider.addUserForToken(initial, ['chat']);
    if (!authProvider.getIntentsForUser(userId).includes('chat')) throw new Error('Twitch chat intent was not registered');
    let current = await authProvider.getAccessTokenForUser(userId, ['chat:read', 'chat:edit']);
    if (!current) throw new Error('Twitch did not return a usable user token');
    try {
      await verifyBotIdentity(current.accessToken, config.twitchClientId, config.twitchBotUsername, userId, current.scope);
      console.log('Twitch authentication diagnostics: refresh attempted=false identityRetrySucceeded=true.');
    } catch (error) {
      if (!(error instanceof TwitchIdentityError) || error.status !== 401) throw error;
      console.log('Twitch authentication diagnostics: refresh attempted=true reason=identity_401.');
      current = await manager.forceRefresh(authProvider, userId);
      await verifyBotIdentity(current.accessToken, config.twitchClientId, config.twitchBotUsername, userId, current.scope);
      console.log('Twitch authentication diagnostics: identityRetrySucceeded=true.');
    }
    await manager.persist({ ...current, userId, username: config.twitchBotUsername });
    await manager.flush();
    processor.setBotIdentity(userId, config.twitchBotUsername);
  } catch (error) {
    console.error(`Twitch authentication diagnostics: outcome=failed category=${classifyAuthError(error)}.`);
    const detail = error instanceof Error ? error.message : 'authentication failed';
    throw new Error(`${detail}. If the refresh token is invalid or revoked, reauthorize with: twitch token --user-token --scopes "chat:read chat:edit"`);
  }

  const chatClient = new ChatClient({
    authProvider,
    channels: [config.twitchChannel],
    rejoinChannelsOnReconnect: true,
  });
  tokenManagers.set(chatClient, manager);
  authProviders.set(chatClient, authProvider);
  authenticatedUserIds.set(chatClient, userId);

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

export async function flushTwitchTokenPersistence(client: ChatClient | undefined): Promise<void> {
  await (client ? tokenManagers.get(client)?.flush() : undefined);
}

/** Shared authenticated identity for optional Twitch capabilities such as EventSub. */
export function getTwitchAuthContext(client: ChatClient): { authProvider: RefreshingAuthProvider; userId: string } | undefined {
  const authProvider = authProviders.get(client); const userId = authenticatedUserIds.get(client);
  return authProvider && userId ? { authProvider, userId } : undefined;
}

export function createRefreshingAuthProvider(config: AppConfig, store: { save(token: StoredTwitchToken): Promise<void> }): RefreshingAuthProvider {
  const authProvider = new RefreshingAuthProvider({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret });
  let pending = Promise.resolve();
  authProvider.onRefresh((userId, token: AccessToken) => {
    pending = pending.then(() => store.save({ ...token, userId, username: config.twitchBotUsername }));
    void pending.catch(() => {
      console.error('Twitch token refreshed but could not be persisted; check token-file permissions.');
    });
  });
  authProvider.onRefreshFailure((userId) => {
    console.error(`Twitch token refresh failed for user ${userId}. Reauthorize with: twitch token --user-token --scopes "chat:read chat:edit"`);
  });
  return authProvider;
}

export async function verifyBotIdentity(accessToken: string, clientId: string, expectedLogin: string, expectedUserId?: string, expectedScopes: string[] = []): Promise<void> {
  const tokenInfo = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!tokenInfo.ok) throw new TwitchIdentityError(tokenInfo.status, `Twitch identity validation failed (HTTP ${tokenInfo.status})`);
  const tokenPayload = await tokenInfo.json() as { client_id?: string; user_id?: string; login?: string; scopes?: string[] };
  if (tokenPayload.client_id && tokenPayload.client_id !== clientId) throw new Error('Twitch token client-ID mismatch');
  const login = tokenPayload.login?.toLowerCase();
  if (!login || login !== expectedLogin.toLowerCase()) throw new Error(`Twitch token belongs to a different account than ${expectedLogin}`);
  if (expectedUserId && tokenPayload.user_id && tokenPayload.user_id !== expectedUserId) throw new Error('Twitch token user-ID mismatch');
  const required = ['chat:read', 'chat:edit'];
  const scopes = tokenPayload.scopes ?? expectedScopes;
  if (required.some((scope) => !scopes.includes(scope))) throw new Error('Twitch token is missing required chat scopes');

  // Confirm the account endpoint as well; this catches a valid token for a
  // different broadcaster before the chat client is constructed.
  const response = await fetch('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId } });
  if (!response.ok) throw new TwitchIdentityError(response.status, `Twitch identity validation failed (HTTP ${response.status})`);
  const payload = await response.json() as { data?: Array<{ login?: string; id?: string; client_id?: string }> };
  if (payload.data?.[0]?.client_id && payload.data[0].client_id !== clientId) throw new Error('Twitch token client-ID mismatch');
  const helixLogin = payload.data?.[0]?.login?.toLowerCase();
  if (!helixLogin || helixLogin !== expectedLogin.toLowerCase()) throw new Error(`Twitch token belongs to a different account than ${expectedLogin}`);
}

function isExpired(token: StoredTwitchToken): boolean {
  return token.expiresIn !== null && token.obtainmentTimestamp + token.expiresIn * 1000 <= Date.now();
}

function classifyAuthError(error: unknown): string {
  if (error instanceof TwitchIdentityError) {
    if (error.status === 401) return 'rejected_access_token';
    if (error.status === 403) return 'insufficient_scope_or_forbidden';
    if (error.status >= 500) return 'twitch_service_error';
    return 'identity_http_error';
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('refresh') && (message.includes('invalid') || message.includes('revoked'))) return 'invalid_or_revoked_refresh_token';
  if (message.includes('client-id')) return 'client_id_mismatch';
  if (message.includes('different account') || message.includes('user-id')) return 'bot_account_mismatch';
  if (message.includes('scope')) return 'insufficient_scope';
  if (message.includes('persistence') || message.includes('token-file')) return 'persistence_failure';
  return 'authentication_error';
}
