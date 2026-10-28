export function makeStoneTitle(body: string): string {
  const firstSentence = body.split(/[.!?](?:\s|$)/u)[0]?.trim() || body.trim();
  return firstSentence.slice(0, 80).trim() || 'Community stone';
}

export function makeStoneFilename(created: string, title: string, id: string): string {
  const date = created.slice(0, 10);
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^[.\- ]+|[.\- ]+$/gu, '')
    .slice(0, 72)
    .replace(/[. ]+$/u, '') || 'community-stone';

  return `${date}-${slug}-${id}.md`;
}
