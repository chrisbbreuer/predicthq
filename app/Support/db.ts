import process from 'node:process'
import { db as stacksDb } from '@stacksjs/database'

interface SqlStatement {
  execute: () => Promise<unknown>
}

interface SqlExecutor {
  unsafe: (query: string, params?: unknown[]) => SqlStatement
  transaction?: <T>(fn: (transaction: SqlExecutor) => Promise<T> | T) => Promise<T>
  updateOrInsert?: (table: string, match: Record<string, unknown>, values: Record<string, unknown>) => Promise<unknown>
  insertOrIgnore?: (table: string, values: Record<string, unknown>) => Promise<unknown>
  upsert?: (
    table: string,
    rows: Record<string, unknown>[],
    conflictColumns: string[],
    mergeColumns?: string[],
  ) => Promise<unknown>
}

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export function databaseValue(value: unknown): unknown {
  // MySQL/Vitess DATETIME columns do not accept RFC 3339's `T` separator or
  // trailing `Z`. The app deliberately works in UTC, so preserve the instant
  // while translating only the wire representation. Doing this at the raw SQL
  // boundary keeps every service portable instead of relying on each caller to
  // remember which database happens to be behind it.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    return value.slice(0, 19).replace('T', ' ')

  return value
}

function parameters(values: unknown[]): unknown[] {
  const flattened = values.length === 1 && Array.isArray(values[0]) ? values[0] : values
  return flattened.map(databaseValue)
}

function portableSql(sql: string): string {
  // SQLite accepts numbered positional parameters (`?1`), whereas the
  // MySQL wire protocol used by Vitess uses ordinary `?` placeholders.
  return sql.replace(/\?\d+/g, '?')
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (Array.isArray(record.rows)) return record.rows as T[]
    if (Array.isArray(record.results)) return record.results as T[]
  }
  return []
}

function runResult(result: unknown): RunResult {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  return {
    changes: Number(record.affectedRows ?? record.changes ?? record.rowCount ?? 0),
    lastInsertRowid: Number(record.lastInsertRowid ?? record.insertId ?? record.last_insert_id ?? 0),
  }
}

export class Statement<T = Record<string, unknown>> {
  constructor(private readonly executor: SqlExecutor, private readonly sql: string) {}

  async all(...values: unknown[]): Promise<T[]> {
    return resultRows<T>(await this.executor.unsafe(portableSql(this.sql), parameters(values)).execute())
  }

  async get(...values: unknown[]): Promise<T | null> {
    return (await this.all(...values))[0] ?? null
  }

  async run(...values: unknown[]): Promise<RunResult> {
    return runResult(await this.executor.unsafe(portableSql(this.sql), parameters(values)).execute())
  }
}

/**
 * Small compatibility surface for PredictHQ's raw SQL while all connection,
 * pooling, dialect, and transaction behavior comes from Stacks. Every method
 * is asynchronous because production uses Vitess over the MySQL protocol.
 */
export class Database {
  constructor(private readonly executor: SqlExecutor = stacksDb as unknown as SqlExecutor) {}

  query<T = Record<string, unknown>>(sql: string): Statement<T> {
    return new Statement<T>(this.executor, sql)
  }

  prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
    return this.query<T>(sql)
  }

  async run(sql: string, values: unknown[] = []): Promise<RunResult> {
    return new Statement(this.executor, sql).run(values)
  }

  async transaction<T>(fn: (transaction: Database) => Promise<T> | T): Promise<T> {
    if (!this.executor.transaction)
      throw new Error('The configured database driver does not support transactions')
    return await this.executor.transaction(async transaction => await fn(new Database(transaction)))
  }

  async updateOrInsert(table: string, match: Record<string, unknown>, values: Record<string, unknown>): Promise<void> {
    if (!this.executor.updateOrInsert)
      throw new Error('The configured database driver does not support updateOrInsert')
    await this.executor.updateOrInsert(table, match, values)
  }

  async insertOrIgnore(table: string, values: Record<string, unknown>): Promise<void> {
    if (!this.executor.insertOrIgnore)
      throw new Error('The configured database driver does not support insertOrIgnore')
    await this.executor.insertOrIgnore(table, values)
  }

  /**
   * Write many rows in one statement, updating the ones that collide.
   *
   * The driver emits `ON DUPLICATE KEY UPDATE` on Vitess and MySQL and
   * `ON CONFLICT … DO UPDATE` on Postgres and SQLite, so this is one round
   * trip whatever the deployment runs on. An empty `mergeColumns` gives
   * the do-nothing form — `INSERT IGNORE` / `DO NOTHING` — which is what
   * an append-only history table wants.
   *
   * Callers must not pass two rows sharing a conflict key. MySQL would
   * quietly keep the last, while Postgres and SQLite reject the statement
   * outright, so the same call would behave differently per dialect. The
   * count returned is the driver's affected-row count, which under MySQL's
   * `ON DUPLICATE KEY UPDATE` counts an update as two — reliable for the
   * ignore form, not a row tally for the merge form.
   */
  async upsert(
    table: string,
    rows: Record<string, unknown>[],
    conflictColumns: string[],
    mergeColumns: string[] = [],
  ): Promise<RunResult> {
    if (rows.length === 0)
      return { changes: 0, lastInsertRowid: 0 }
    if (!this.executor.upsert)
      throw new Error('The configured database driver does not support upsert')
    return runResult(await this.executor.upsert(table, rows, conflictColumns, mergeColumns))
  }

  close(): void {
    // The Stacks connection pool is process-scoped and intentionally remains
    // open across requests and jobs.
  }
}

/** Retained for backup/import tooling that needs to locate the legacy file. */
export function resolveDbPath(): string {
  const configured = process.env.DB_DATABASE_PATH || 'database/stacks.sqlite'
  return configured.startsWith('/') ? configured : `${process.cwd()}/${configured}`
}

export function openRead(): Database {
  return new Database()
}

export function openWrite(): Database {
  return new Database()
}

export async function transact<T>(database: Database, fn: (transaction: Database) => Promise<T> | T): Promise<T> {
  return await database.transaction(fn)
}
