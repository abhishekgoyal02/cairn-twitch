import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/chat/command-parser.js';

describe('parseCommand', () => {
  it('recognizes !ping', () => {
    expect(parseCommand('!ping')).toEqual({ name: 'ping', args: '' });
  });

  it('normalizes command names case-insensitively', () => {
    expect(parseCommand('  !PiNg hello  ')).toEqual({ name: 'ping', args: 'hello' });
  });

  it('ignores ordinary messages', () => {
    expect(parseCommand('hello chat')).toBeNull();
  });

  it('parses unknown commands without treating them as ping', () => {
    expect(parseCommand('!unknown')).toEqual({ name: 'unknown', args: '' });
  });

  it('parses stone text and preserves the command boundary', () => {
    expect(parseCommand('  !StOnE  Kevin is the boss  ')).toEqual({
      name: 'stone',
      args: 'Kevin is the boss',
    });
    expect(parseCommand('chat says !stone in the middle')).toBeNull();
  });
});
