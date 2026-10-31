import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../src/twitch/token-store.js';
import { createRefreshingAuthProvider, verifyBotIdentity, TwitchIdentityError } from '../src/twitch/client.js';
import { ChatClient } from '@twurple/chat';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const token = (accessToken: string, refreshToken: string) => ({ userId: '123', username: 'hackathonpart', accessToken, refreshToken, scope: ['chat:read', 'chat:edit'], expiresIn: 3600, obtainmentTimestamp: Date.now() });

describe('TokenStore', () => {
  it('persists rotated refresh tokens and recovers them after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-token-')); roots.push(root);
    const store = new TokenStore(path.join(root, 'tokens.json'));
    await store.save(token('access-one', 'refresh-one'));
    await store.save(token('access-two', 'refresh-two'));
    const restarted = new TokenStore(path.join(root, 'tokens.json'));
    expect(restarted.load()).toMatchObject({ accessToken: 'access-two', refreshToken: 'refresh-two', userId: '123' });
  });
  it('rejects incomplete token files without exposing values', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-token-')); roots.push(root);
    const file = path.join(root, 'tokens.json'); await fs.writeFile(file, JSON.stringify({ accessToken: 'secret' }));
    expect(() => new TokenStore(file).load()).toThrow(/incomplete/);
    try { new TokenStore(file).load(); } catch (error) { expect((error as Error).message.includes('secret')).toBe(false); }
  });

  it('persists a successful Twurple refresh and rotated refresh token', async () => {
    const saved: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, scope: ['chat:read', 'chat:edit'] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const provider = createRefreshingAuthProvider({ twitchClientId: 'client', twitchClientSecret: 'client-secret', twitchBotUsername: 'hackathonpart', twitchChannel: 'channel', twitchTokenFile: 'unused', vaultPath: 'vault' }, { save: async (value) => { saved.push(value); } });
    provider.addUser('123', token('access-old', 'refresh-old'), ['chat:read', 'chat:edit']);
    await provider.refreshAccessTokenForUser('123');
    await new Promise((resolve) => setImmediate(resolve));
    expect(saved).toEqual([expect.objectContaining({ accessToken: 'access-new', refreshToken: 'refresh-new', userId: '123' })]);
    vi.unstubAllGlobals();
  });

  it('passes the configured client secret to the OAuth refresh request', async () => {
    let requestUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, _init?: RequestInit) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, scope: ['chat:read', 'chat:edit'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const provider = createRefreshingAuthProvider({ twitchClientId: 'client', twitchClientSecret: 'client-secret', twitchBotUsername: 'hackathonpart', twitchChannel: 'channel', twitchTokenFile: 'unused', vaultPath: 'vault' }, { save: async () => undefined });
    provider.addUser('123', token('access-old', 'refresh-old'), ['chat:read', 'chat:edit']);
    await provider.refreshAccessTokenForUser('123');
    const query = new URL(requestUrl).searchParams;
    expect(query.get('client_id')).toBe('client');
    expect(query.get('client_secret')).toBe('client-secret');
    expect(requestUrl).not.toContain('access-old');
    vi.unstubAllGlobals();
  });

  it('registers the chat intent and can retrieve its user token', async () => {
    const provider = createRefreshingAuthProvider({ twitchClientId: 'client', twitchClientSecret: 'client-secret', twitchBotUsername: 'hackathonpart', twitchChannel: 'channel', twitchTokenFile: 'unused', vaultPath: 'vault' }, { save: async () => undefined });
    provider.addUser('123', token('access-chat', 'refresh-chat'), ['chat']);
    expect(provider.getIntentsForUser('123')).toContain('chat');
    expect(() => new ChatClient({ authProvider: provider, channels: ['channel'] })).not.toThrow();
    await expect(provider.getAccessTokenForUser('123', ['chat:read', 'chat:edit'])).resolves.toMatchObject({ accessToken: 'access-chat' });
  });

  it('surfaces invalid refresh tokens without persisting a replacement', async () => {
    const saved: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 400, message: 'Invalid refresh token' }), { status: 400 })));
    const provider = createRefreshingAuthProvider({ twitchClientId: 'client', twitchClientSecret: 'client-secret', twitchBotUsername: 'hackathonpart', twitchChannel: 'channel', twitchTokenFile: 'unused', vaultPath: 'vault' }, { save: async (value) => { saved.push(value); } });
    provider.addUser('123', token('access-old', 'refresh-invalid'), ['chat:read', 'chat:edit']);
    await expect(provider.refreshAccessTokenForUser('123')).rejects.toBeTruthy();
    expect(saved).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('classifies an identity 401 without exposing bearer credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    try {
      await verifyBotIdentity('secret-access-token', 'client', 'hackathonpart');
      throw new Error('expected identity validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TwitchIdentityError);
      expect((error as TwitchIdentityError).status).toBe(401);
      expect(String(error)).not.toContain('secret-access-token');
    }
    vi.unstubAllGlobals();
  });

  it('serializes rotation work and recovers a stale lock safely', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-token-')); roots.push(root);
    const file = path.join(root, 'tokens.json');
    const lock = `${file}.lock`;
    await fs.writeFile(lock, 'stale', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    const store = new TokenStore(file);
    const order: string[] = [];
    await Promise.all([
      store.withRotationLock(async () => { order.push('first'); await new Promise((resolve) => setTimeout(resolve, 10)); }),
      store.withRotationLock(async () => { order.push('second'); }),
    ]);
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(['first', 'second']));
    expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined();
  });

  it('rejects client mismatch, wrong identity, and missing scopes safely', async () => {
    const cases = [
      { payload: { client_id: 'other', user_id: '123', login: 'hackathonpart', scopes: ['chat:read', 'chat:edit'] }, message: /client-ID/ },
      { payload: { client_id: 'client', user_id: '123', login: 'someoneelse', scopes: ['chat:read', 'chat:edit'] }, message: /different account/ },
      { payload: { client_id: 'client', user_id: '123', login: 'hackathonpart', scopes: ['chat:read'] }, message: /missing required/ },
    ];
    for (const item of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(item.payload), { status: 200 })));
      await expect(verifyBotIdentity('opaque-token', 'client', 'hackathonpart', '123')).rejects.toThrow(item.message);
      vi.unstubAllGlobals();
    }
  });
});
