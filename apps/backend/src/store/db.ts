// SQLite trace store (node:sqlite) with plain-SQL migrations from ./migrations/NNN_name.sql.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { TraceEvent } from "@terrarium/shared";
import { BlobStore } from "./blobs.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type Row = Record<string, SQLInputValue>;

export class Store {
  readonly db: DatabaseSync;
  readonly blobs: BlobStore;
  private stmts = new Map<string, StatementSync>();

  constructor(dbPath: string, blobDir: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;");
    this.blobs = new BlobStore(blobDir);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = Number(file.split("_")[0]);
      if (applied.has(version)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", version, file, Date.now());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint } {
    return this.prepare(sql).run(...params);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- events ----

  appendEvent(event: TraceEvent): void {
    const { sessionId, seq, ts, type, ...rest } = event as TraceEvent & Record<string, unknown>;
    this.run("INSERT OR REPLACE INTO events (session_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)", sessionId, seq, ts, type, JSON.stringify(rest));
  }

  events(sessionId: string, afterSeq = 0, limit = 5000): TraceEvent[] {
    const rows = this.all<{ seq: number; ts: number; type: string; payload_json: string }>(
      "SELECT seq, ts, type, payload_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      sessionId,
      afterSeq,
      limit,
    );
    return rows.map((r) => ({ sessionId, seq: r.seq, ts: r.ts, type: r.type, ...JSON.parse(r.payload_json) }) as TraceEvent);
  }

  // ---- settings ----

  getSetting<T>(key: string, fallback: T): T {
    const row = this.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
    return row ? (JSON.parse(row.value_json) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.run("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}
