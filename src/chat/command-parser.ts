export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const match = /^!([a-z0-9_]+)(?:\s+(.*))?$/is.exec(text.trim());
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() ?? '',
  };
}
