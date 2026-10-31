import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AccessToken } from '@twurple/auth';
import type { AppConfig } from '../config.js';

export interface StoredTwitchToken extends AccessToken {
  userId: string;
  username?: string;
}

export class TokenStore {
  constructor(public readonly filePath: string) {}

  private writes: Promise<void> = Promise.resolve();
  private lockHeld = false;

  public load(): StoredTwitchToken | undefined {
    if (!fsSync.existsSync(this.filePath)) return undefined;
    try {
      const value = JSON.parse(fsSync.readFileSync(this.filePath, 'utf8')) as Partial<StoredTwitchToken>;
      if (!value.userId || !value.accessToken || !value.refreshToken) throw new Error('token file is incomplete');
      return {
        userId: value.userId, username: value.username,
        accessToken: value.accessToken, refreshToken: value.refreshToken,
        scope: Array.isArray(value.scope) ? value.scope : [],
        expiresIn: typeof value.expiresIn === 'number' || value.expiresIn === null ? value.expiresIn : null,
        obtainmentTimestamp: typeof value.obtainmentTimestamp === 'number' ? value.obtainmentTimestamp : Date.now(),
      };
    } catch (error) {
      throw new Error(`Unable to read Twitch token store: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }
  }

  public async save(token: StoredTwitchToken): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(() => this.saveLocked(token));
    return this.writes;
  }

  /** Waits for all token replacements queued by this process. */
  public async flush(): Promise<void> { await this.writes; }

  /** Serialize a refresh-token rotation across Cairn processes. */
  public async withRotationLock<T>(action: () => Promise<T>): Promise<T> {
    const release = await acquireTokenLock(`${this.filePath}.lock`);
    this.lockHeld = true;
    try { return await action(); }
    finally { this.lockHeld = false; await release(); }
  }

  private async saveLocked(token: StoredTwitchToken): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const release = this.lockHeld ? async () => undefined : await acquireTokenLock(`${this.filePath}.lock`);
    const temp = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { await fs.chmod(temp, 0o600); } catch { /* Windows may not support POSIX modes. */ }
      // Rename is atomic on the supported local filesystems. Importantly, we never
      // remove the previous file before this operation, so a failed replacement
      // leaves the last valid credentials untouched.
      try {
        await fs.rename(temp, this.filePath);
      } catch (error) {
        // Windows can refuse to replace an existing file with rename. Keep a
        // same-directory backup while performing the replacement and restore it
        // if the second rename fails.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EINVAL') throw error;
        const backup = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.bak`;
        await fs.rename(this.filePath, backup);
        try {
          await fs.rename(temp, this.filePath);
          await fs.unlink(backup).catch(() => undefined);
        } catch (replacementError) {
          await fs.rename(backup, this.filePath).catch(() => undefined);
          throw replacementError;
        }
      }
      try { await fs.chmod(this.filePath, 0o600); } catch { /* best effort */ }
    } finally {
      await fs.unlink(temp).catch(() => undefined);
      await release();
    }
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 8_000;

async function acquireTokenLock(lockPath: string): Promise<() => Promise<void>> {
  const started = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.close();
      return async () => { await fs.unlink(lockPath).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Rename first so another process can acquire a fresh lock; do not
          // blindly delete a lock owned by a live writer.
          const stale = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
          try { await fs.rename(lockPath, stale); await fs.unlink(stale).catch(() => undefined); } catch { /* another process won */ }
          continue;
        }
      } catch { /* lock disappeared; retry */ }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('Twitch token persistence lock timeout');
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

export function tokenStoreFromConfig(config: AppConfig): { store: TokenStore; initial?: StoredTwitchToken; source: 'persisted' | 'bootstrap' | 'missing' } {
  const store = new TokenStore(config.twitchTokenFile);
  const saved = store.load();
  if (saved) return { store, initial: saved, source: 'persisted' };
  if (!config.twitchAccessToken || !config.twitchRefreshToken) return { store, source: 'missing' };
  return {
    store,
    initial: {
      userId: config.twitchUserId ?? '', username: config.twitchBotUsername,
      accessToken: config.twitchAccessToken, refreshToken: config.twitchRefreshToken,
      scope: ['chat:read', 'chat:edit'], expiresIn: config.twitchAccessTokenExpiresIn ?? null,
      obtainmentTimestamp: config.twitchTokenObtainmentTimestamp ?? Date.now(),
    },
    source: 'bootstrap',
  };
}
