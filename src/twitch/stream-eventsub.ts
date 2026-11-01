import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import type { RefreshingAuthProvider } from '@twurple/auth';
import type { StreamOfflineEvent, StreamOnlineEvent } from '../chat/stream-service.js';

export interface StreamEventSource {
  start(): Promise<{ broadcasterId: string }>;
  stop(): Promise<void>;
  getLiveStream(): Promise<{ streamId: string; startedAt: string } | null>;
}

/** Twurple 8 EventSub WebSocket adapter. The SDK owns Twitch reconnect/session migration. */
export class TwurpleStreamEventSource implements StreamEventSource {
  private readonly api: ApiClient;
  private readonly listener: EventSubWsListener;
  private broadcasterId?: string;
  private started = false;

  constructor(
    authProvider: RefreshingAuthProvider,
    private readonly channelLogin: string,
    private readonly handlers: { online: (event: StreamOnlineEvent) => Promise<void>; offline: (event: StreamOfflineEvent) => Promise<void> },
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.api = new ApiClient({ authProvider });
    this.listener = new EventSubWsListener({ apiClient: this.api });
    this.listener.onUserSocketReady((userId) => this.log(`Stream EventSub socket ready user=${userId}.`));
    this.listener.onUserSocketDisconnect((_userId, error) => this.log(`Stream EventSub socket disconnected outcome=${error ? 'error' : 'closed'}.`));
    this.listener.onRevoke((_subscription, status) => this.log(`Stream EventSub subscription revoked status=${status}.`));
  }

  public async resolveBroadcaster(): Promise<string> {
    if (this.broadcasterId) return this.broadcasterId;
    const broadcaster = await this.api.users.getUserByName(this.channelLogin);
    if (!broadcaster) throw new Error('configured Twitch channel could not be resolved');
    this.broadcasterId = broadcaster.id;
    return broadcaster.id;
  }

  public async start(): Promise<{ broadcasterId: string }> {
    if (this.started && this.broadcasterId) return { broadcasterId: this.broadcasterId };
    const broadcasterId = await this.resolveBroadcaster();
    this.listener.onStreamOnline(broadcasterId, (event) => {
      void this.handlers.online({ broadcasterId: event.broadcasterId, streamId: event.id, startedAt: event.startDate.toISOString() });
    });
    this.listener.onStreamOffline(broadcasterId, (event) => {
      // Twitch stream.offline supplies no stream ID or event timestamp. The
      // lifecycle service matches the persisted active session and leaves
      // ended absent rather than fabricating an exact time.
      void this.handlers.offline({ broadcasterId: event.broadcasterId });
    });
    this.listener.start();
    this.started = true;
    this.log(`Stream EventSub subscriptions requested broadcaster=${broadcasterId}.`);
    return { broadcasterId };
  }

  public async getLiveStream(): Promise<{ streamId: string; startedAt: string } | null> {
    if (!this.broadcasterId) return null;
    const stream = await this.api.streams.getStreamByUserId(this.broadcasterId);
    return stream ? { streamId: stream.id, startedAt: stream.startDate.toISOString() } : null;
  }

  public async stop(): Promise<void> { if (this.started) this.listener.stop(); this.started = false; }
}
