import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { VaultNote } from '../vault/stone-schema.js';

const require = createRequire(import.meta.url);
const sqliteModuleName = 'node:' + 'sqlite';
const { DatabaseSync } = require(sqliteModuleName) as typeof import('node:sqlite');

export interface IndexedNote {
  id: string;
  type: string;
  title: string;
  status: string;
  author: string;
  created: string;
  relativePath: string;
  body: string;
  rank?: number;
}

export class SqliteIndex {
  private readonly db: DatabaseSyncType;

  constructor(private readonly databasePath: string, private readonly vaultPath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          author TEXT NOT NULL,
          created TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          body TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          author
        );
      `);
    } catch (error) {
      this.db.close();
      throw new Error(`SQLite FTS5 initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public upsert(note: VaultNote, relativePath: string): void {
    this.withTransaction(() => {
      this.db.prepare('DELETE FROM notes_fts WHERE id = ?').run(note.frontmatter.id);
      this.db.prepare(`
        INSERT INTO notes (id, type, title, status, author, created, relative_path, body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          status = excluded.status,
          author = excluded.author,
          created = excluded.created,
          relative_path = excluded.relative_path,
          body = excluded.body
      `).run(
        note.frontmatter.id,
        note.frontmatter.type,
        note.frontmatter.title,
        note.frontmatter.status,
        note.frontmatter.author,
        note.frontmatter.created,
        relativePath,
        note.body,
      );
      this.db.prepare('INSERT INTO notes_fts (id, title, body, author) VALUES (?, ?, ?, ?)').run(
        note.frontmatter.id,
        note.frontmatter.title,
        note.body,
        note.frontmatter.author,
      );
    });
  }

  public rebuild(notes: IndexedNote[]): void {
    this.withTransaction(() => {
      this.db.exec('DELETE FROM notes; DELETE FROM notes_fts;');
      const metadata = this.db.prepare(`
        INSERT INTO notes (id, type, title, status, author, created, relative_path, body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const search = this.db.prepare('INSERT INTO notes_fts (id, title, body, author) VALUES (?, ?, ?, ?)');
      for (const note of notes) {
        metadata.run(note.id, note.type, note.title, note.status, note.author, note.created, note.relativePath, note.body);
        search.run(note.id, note.title, note.body, note.author);
      }
    });
  }

  public search(query: string, limit = 8): IndexedNote[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const tokens = trimmed.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const safeQuery = tokens
      .slice(0, 16)
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(' OR ');
    try {
      return this.db.prepare(`
      SELECT n.id, n.type, n.title, n.status, n.author, n.created,
             n.relative_path AS relativePath, n.body, bm25(notes_fts) AS rank
      FROM notes n
      JOIN notes_fts f ON f.id = n.id
      WHERE notes_fts MATCH ?
      ORDER BY rank ASC, n.created DESC
      LIMIT ?
    `).all(safeQuery, Math.max(1, Math.floor(limit))) as unknown as IndexedNote[];
    } catch (error) {
      throw new Error(`SQLite search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public list(): IndexedNote[] {
    return this.db.prepare(`
      SELECT id, type, title, status, author, created,
             relative_path AS relativePath, body
      FROM notes ORDER BY id
    `).all() as unknown as IndexedNote[];
  }

  public remove(id: string): void {
    this.withTransaction(() => {
      this.db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    });
  }

  public close(): void {
    this.db.close();
  }

  private withTransaction(action: () => void): void {
    this.db.exec('BEGIN');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
