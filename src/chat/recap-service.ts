import { scanVault } from '../graph/scanner.js';
import type { LoreNote, StoneNote } from '../vault/stone-schema.js';
import type { NormalizedChatMessage } from './types.js';

const MAX_REPLY_LENGTH = 499;
const CHANNEL_COOLDOWN_MS = 10_000;
const VIEWER_COOLDOWN_MS = 30_000;

export interface RecapServiceOptions {
  vaultPath: string;
  now?: () => number;
}

/** Deterministic, Markdown-backed onboarding. This service has no LLM dependency. */
export class RecapService {
  private readonly now: () => number;
  private readonly channelCooldowns = new Map<string, number>();
  private readonly viewerCooldowns = new Map<string, number>();

  constructor(private readonly options: RecapServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  public async recap(message: NormalizedChatMessage): Promise<string> {
    const now = this.now();
    this.prune(now);
    const channel = message.channel.toLowerCase();
    const viewer = `${channel}:${(message.senderId ?? message.sender).toLowerCase()}`;
    if (now < (this.channelCooldowns.get(channel) ?? 0) || now < (this.viewerCooldowns.get(viewer) ?? 0)) {
      return 'Recap is cooling down; please try again shortly.';
    }

    const scan = await scanVault(this.options.vaultPath);
    const canonStones = new Map<string, StoneNote>(scan.notes
      .filter((record): record is typeof record & { note: StoneNote } => record.note.frontmatter.type === 'stone' && record.note.frontmatter.status === 'canon')
      .map((record) => [record.note.frontmatter.id, record.note]));
    const lore = scan.notes
      .filter((record): record is typeof record & { note: LoreNote } => record.note.frontmatter.type === 'lore' && record.note.frontmatter.status === 'canon')
      .sort((left, right) => left.note.frontmatter.created.localeCompare(right.note.frontmatter.created)
        || left.note.frontmatter.id.localeCompare(right.note.frontmatter.id));

    const response = lore.length === 0
      ? 'Welcome to Cairn. Community canon is still being established—help preserve memorable moments with !stone.'
      : formatRecap(lore.map((record) => {
        const note = record.note;
        if (note.frontmatter.type !== 'lore') throw new Error('unreachable');
        const stoneIds = [...note.body.matchAll(/\[\[(st_[A-Za-z0-9]{6})\]\]/gu)].map((match) => match[1]);
        const evidence = stoneIds.map((id) => canonStones.get(id)).filter((stone): stone is StoneNote => Boolean(stone));
        return { id: note.frontmatter.id, title: note.frontmatter.title, evidence };
      }));

    this.channelCooldowns.set(channel, now + CHANNEL_COOLDOWN_MS);
    this.viewerCooldowns.set(viewer, now + VIEWER_COOLDOWN_MS);
    return bounded(response);
  }

  private prune(now: number): void {
    for (const [key, until] of this.channelCooldowns) if (until <= now) this.channelCooldowns.delete(key);
    for (const [key, until] of this.viewerCooldowns) if (until <= now) this.viewerCooldowns.delete(key);
  }
}

function formatRecap(topics: Array<{ id: string; title: string; evidence: Array<{ frontmatter: { id: string; title: string } }> }>): string {
  const parts = topics.map((topic) => {
    const evidence = topic.evidence[0];
    return evidence
      ? `${clean(topic.title)} (${topic.id}; evidence: ${clean(evidence.frontmatter.title)} ${evidence.frontmatter.id})`
      : `${clean(topic.title)} (${topic.id})`;
  });
  return `Welcome to Cairn. Community canon: ${parts.join('; ')}.`;
}

function clean(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }

function bounded(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_REPLY_LENGTH) return value;
  return `${chars.slice(0, MAX_REPLY_LENGTH - 1).join('')}…`;
}
