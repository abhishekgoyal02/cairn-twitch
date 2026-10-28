import { MessageDeduplicator } from './deduplicator.js';
import { parseCommand } from './command-parser.js';
import type { NormalizedChatMessage } from './types.js';

export type StoneCommandHandler = (message: NormalizedChatMessage, body: string) => Promise<string>;
export type WhyCommandHandler = (topic: string) => Promise<string>;

export interface MessageProcessorOptions {
  botUsername: string;
  deduplicator?: MessageDeduplicator;
  reply: (channel: string, text: string) => Promise<void> | void;
  stone?: StoneCommandHandler;
  why?: WhyCommandHandler;
  log?: (message: string) => void;
}

export class MessageProcessor {
  private readonly deduplicator: MessageDeduplicator;
  private readonly botUsername: string;

  constructor(private readonly options: MessageProcessorOptions) {
    this.deduplicator = options.deduplicator ?? new MessageDeduplicator();
    this.botUsername = options.botUsername.toLowerCase();
  }

  public async process(message: NormalizedChatMessage | null): Promise<void> {
    if (!message) {
      this.options.log?.('Ignored chat event without a usable message ID.');
      return;
    }

    if (message.sender.toLowerCase() === this.botUsername) return;
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

    if (command.name !== 'ping') return;

    this.options.log?.(`Recognized !ping from ${message.sender} in #${message.channel}.`);
    this.options.log?.(`Attempting to send !ping reply in #${message.channel}.`);

    try {
      await this.options.reply(message.channel, 'Cairn is online.');
    } catch {
      this.options.log?.(`Failed to send !ping reply in #${message.channel}.`);
    }
  }
}
