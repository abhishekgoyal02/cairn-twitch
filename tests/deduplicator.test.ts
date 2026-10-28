import { describe, expect, it } from 'vitest';
import { MessageDeduplicator } from '../src/chat/deduplicator.js';

describe('MessageDeduplicator', () => {
  it('accepts a message ID once and rejects repeats', () => {
    const deduplicator = new MessageDeduplicator();
    expect(deduplicator.accept('message-1')).toBe(true);
    expect(deduplicator.accept('message-1')).toBe(false);
    expect(deduplicator.hasSeen('message-1')).toBe(true);
  });

  it('rejects blank IDs', () => {
    expect(new MessageDeduplicator().accept('  ')).toBe(false);
  });

  it('evicts the oldest IDs at its configured retention limit', () => {
    const deduplicator = new MessageDeduplicator(2);
    expect(deduplicator.accept('message-1')).toBe(true);
    expect(deduplicator.accept('message-2')).toBe(true);
    expect(deduplicator.accept('message-3')).toBe(true);
    expect(deduplicator.accept('message-1')).toBe(true);
  });
});
