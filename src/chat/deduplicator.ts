export class MessageDeduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 10_000) {}

  public hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  public accept(id: string): boolean {
    if (!id.trim() || this.seen.has(id)) return false;
    if (this.order.length >= this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    this.seen.add(id);
    this.order.push(id);
    return true;
  }
}
