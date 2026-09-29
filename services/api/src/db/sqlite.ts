import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Тонкая обёртка над встроенным node:sqlite.
 * Локальный режим по умолчанию: без сервера БД. SQL держим переносимым на PostgreSQL.
 */
export type Row = Record<string, unknown>;
type Param = SQLInputValue | undefined | boolean;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function sanitize(params: Param[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export class Db {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
    this.raw = new DatabaseSync(filePath);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (filePath !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...sanitize(params)) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...sanitize(params)) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...sanitize(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** INSERT по объекту колонок. */
  insert(table: string, values: Record<string, Param>): { lastInsertRowid: number } {
    const cols = Object.keys(values);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return this.run(sql, ...cols.map((c) => values[c]));
  }

  /** UPDATE по объекту колонок и условию. */
  update(table: string, values: Record<string, Param>, where: string, ...whereParams: Param[]): number {
    const cols = Object.keys(values);
    if (cols.length === 0) return 0;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${where}`;
    return this.run(sql, ...cols.map((c) => values[c]), ...whereParams).changes;
  }

  /** Транзакция (вложенные вызовы — через SAVEPOINT). */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.txDepth}`;
    this.raw.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  migrate(): string[] {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const done: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      this.tx(() => {
        this.raw.exec(sql);
        this.insert('schema_migrations', { name: f, applied_at: new Date().toISOString() });
      });
      done.push(f);
    }
    return done;
  }

  close(): void {
    this.raw.close();
  }
}

export const nowIso = (): string => new Date().toISOString();

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const toJson = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));
export const toBool = (value: unknown): boolean => value === 1 || value === true || value === '1';
export const toBoolOrNull = (value: unknown): boolean | null => (value === null || value === undefined ? null : toBool(value));
