import { MessageDeduplicator } from './deduplicator.js';
import { parseCommand } from './command-parser.js';
import type { NormalizedChatMessage } from './types.js';

export type StoneCommandHandler = (message: NormalizedChatMessage, body: string) => Promise<string>;
export type WhyCommandHandler = (topic: string) => Promise<string>;
export type PublicCommandHandler = (message: NormalizedChatMessage) => Promise<string>;
export type GovernanceCommandHandler = (message: NormalizedChatMessage, args: string) => Promise<string>;

export interface MessageProcessorOptions {
  botUsername: string;
  botUserId?: string;
  deduplicator?: MessageDeduplicator;
  reply: (channel: string, text: string) => Promise<void> | void;
  stone?: StoneCommandHandler;
  why?: WhyCommandHandler;
  recap?: PublicCommandHandler;
  mystones?: PublicCommandHandler;
  canon?: GovernanceCommandHandler;
  correct?: GovernanceCommandHandler;
  forget?: GovernanceCommandHandler;
  promise?: GovernanceCommandHandler;
  done?: GovernanceCommandHandler;
  log?: (message: string) => void;
}

export class MessageProcessor {
  private readonly deduplicator: MessageDeduplicator;
  private botUsername: string;
  private botUserId?: string;

  constructor(private readonly options: MessageProcessorOptions) {
    this.deduplicator = options.deduplicator ?? new MessageDeduplicator();
    this.botUsername = options.botUsername.toLowerCase();
    this.botUserId = options.botUserId?.trim();
  }

  /** Bind the authenticated Twitch identity after OAuth bootstrap completes. */
  public setBotIdentity(userId: string, username: string): void {
    this.botUserId = userId.trim();
    this.botUsername = username.trim().toLowerCase();
  }

  public async process(message: NormalizedChatMessage | null): Promise<void> {
    if (!message) {
      this.options.log?.('Ignored chat event without a usable message ID.');
      return;
    }

    // Use Twitch's immutable user ID when available. Username comparison is a
    // defensive fallback for synthetic/test events or incomplete metadata.
    if ((this.botUserId && message.senderId === this.botUserId) || message.sender.trim().toLowerCase() === this.botUsername) return;
    if (!this.deduplicator.accept(message.id)) return;

    const command = parseCommand(message.text);
    if (!command) return;

    if (command.name === 'stone') {
      if (!this.options.stone) return;
      this.options.log?.(`Recognized !stone from ${message.sender} in #${message.channel}.`);
      let response: string;
      try {
        response = await this.options.stone(message, command.args);
      } catch {
        this.options.log?.(`Failed to process !stone reply in #${message.channel}.`);
        response = "Couldn't save that stone. Please try again.";
      }
      try {
        await this.options.reply(message.channel, response);
      } catch {
        this.options.log?.(`Failed to send !stone reply in #${message.channel}.`);
      }
      return;
    }

    if (command.name === 'why') {
      if (!this.options.why) return;
      this.options.log?.(`Recognized !why from ${message.sender} in #${message.channel}.`);
      let response: string;
      try {
        response = await this.options.why(command.args);
      } catch {
        this.options.log?.(`Failed to retrieve !why evidence in #${message.channel}.`);
        response = 'Not in the vault yet.';
      }
      try {
        await this.options.reply(message.channel, response);
      } catch {
        this.options.log?.(`Failed to send !why reply in #${message.channel}.`);
      }
      return;
    }

    if (command.name === 'recap' || command.name === 'mystones') {
      const handler = command.name === 'recap' ? this.options.recap : this.options.mystones;
      if (!handler) return;
      this.options.log?.(`Recognized !${command.name} from ${message.sender} in #${message.channel}.`);
      try {
        await this.safeReply(message.channel, await handler(message));
      } catch {
        this.options.log?.(`Failed to process !${command.name} in #${message.channel}.`);
        await this.safeReply(message.channel, 'That command could not be completed.');
      }
      return;
    }

    if (command.name === 'canon' || command.name === 'correct' || command.name === 'forget' || command.name === 'promise' || command.name === 'done') {
      const handler = command.name === 'canon' ? this.options.canon
        : command.name === 'correct' ? this.options.correct
          : command.name === 'forget' ? this.options.forget
            : command.name === 'promise' ? this.options.promise : this.options.done;
      if (!handler) return;
      const authorized = message.isModerator || message.isBroadcaster;
      const args = command.args;
      if (!authorized) {
        await this.safeReply(message.channel, 'Only moderators or the broadcaster can use that command.');
        return;
      }
      try {
        const response = await handler(message, args);
        await this.safeReply(message.channel, response);
      } catch {
        this.options.log?.(`Failed to process !${command.name} in #${message.channel}.`);
        await this.safeReply(message.channel, 'That command could not be completed.');
      }
      return;
    }

    if (command.name !== 'ping') return;

    this.options.log?.(`Recognized !ping from ${message.sender} in #${message.channel}.`);
    this.options.log?.(`Attempting to send !ping reply in #${message.channel}.`);

    try {
      await this.options.reply(message.channel, 'Cairn is online.');
    } catch {
      this.options.log?.(`Failed to send !ping reply in #${message.channel}.`);
    }
  }

  private async safeReply(channel: string, text: string): Promise<void> {
    try { await this.options.reply(channel, text.slice(0, 499)); }
    catch { this.options.log?.(`Failed to send reply in #${channel}.`); }
  }
}
