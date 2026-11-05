// A minimal D1Database over node:sqlite, so the D1Store runs the same contract tests as the MemoryStore.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  private exec() { return this.db.prepare(this.sql).all(...(this.args as never[])) as Record<string, unknown>[]; }
  async first<T>() { return (this.exec()[0] ?? null) as T | null; }
  async all<T>() { return { results: this.exec() as T[], success: true, meta: {} }; }
  async run() { this.exec(); return { success: true, meta: {} }; }
  runSync() { this.exec(); }
}

export function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try { for (const s of stmts) s.runSync(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      return [];
    },
  } as unknown as D1Database;
}
