import type { CLI } from '@stacksjs/types'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { log } from '@stacksjs/cli'
import { Database as TargetDatabase, resolveDbPath } from '../Support/db'

interface ImportOptions {
  source?: string
  batchSize?: string | number
  verifyOnly?: boolean
}

interface TargetColumn {
  Field: string
  Type: string
  Null: 'YES' | 'NO'
  Default: unknown
}

interface SourceColumn {
  name: string
}

const quote = (identifier: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier))
    throw new Error(`Unsafe database identifier: ${identifier}`)
  return `\`${identifier}\``
}

function targetTables(): string[] {
  const dir = join(process.cwd(), 'database', 'migrations', 'vitess')
  if (!existsSync(dir))
    throw new Error('database/migrations/vitess is missing; run buddy migrate:regenerate vitess first')
  return readdirSync(dir).sort().flatMap((file) => {
    const match = file.match(/^\d+-create-(.+)-table\.sql$/)
    return match?.[1] ? [match[1]] : []
  }).filter(table => table !== 'migrations' && table !== 'migration_locks')
}

function normalizeDatetime(value: unknown, column: TargetColumn): unknown {
  if (!/^(?:date|datetime|timestamp)/i.test(column.Type)) return value
  if (value === null || value === undefined || value === '')
    return column.Null === 'YES' ? null : '1970-01-01 00:00:00'
  if (typeof value !== 'string') return value
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().slice(0, 19).replace('T', ' ')
}

async function importTable(
  source: SqliteDatabase,
  target: TargetDatabase,
  table: string,
  requestedBatchSize: number,
  verifyOnly: boolean,
): Promise<{ source: number, target: number, copied: number }> {
  const sourceExists = source.query<{ count: number }, [string, string]>(
    'SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?',
  ).get('table', table)?.count
  if (!sourceExists) return { source: 0, target: 0, copied: 0 }

  const targetColumns = await target.query<TargetColumn>(`SHOW COLUMNS FROM ${quote(table)}`).all()
  const sourceColumns = source.query<SourceColumn, []>(`PRAGMA table_info(${quote(table)})`).all()
  const sourceNames = new Set(sourceColumns.map(column => column.name))
  const columns = targetColumns.filter(column => sourceNames.has(column.Field))
  if (!columns.length) throw new Error(`${table} has no columns shared by SQLite and Vitess`)

  const sourceCount = Number(source.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get()?.count || 0)
  let copied = 0
  if (!verifyOnly && sourceCount > 0) {
    const batchSize = Math.max(1, Math.min(requestedBatchSize, Math.floor(60_000 / columns.length)))
    for (let offset = 0; offset < sourceCount; offset += batchSize) {
      const rows = source.query<Record<string, unknown>, [number, number]>(
        `SELECT ${columns.map(column => quote(column.Field)).join(', ')} FROM ${quote(table)} ORDER BY rowid LIMIT ? OFFSET ?`,
      ).all(batchSize, offset)
      if (!rows.length) break
      const placeholders = `(${columns.map(() => '?').join(', ')})`
      const values = rows.flatMap(row => columns.map(column => normalizeDatetime(row[column.Field], column)))
      await target.run(
        `INSERT IGNORE INTO ${quote(table)} (${columns.map(column => quote(column.Field)).join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}`,
        values,
      )
      copied += rows.length
    }
  }

  const targetCount = Number((await target.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get())?.count || 0)
  if (targetCount < sourceCount)
    throw new Error(`${table} verification failed: SQLite has ${sourceCount} rows, Vitess has ${targetCount}`)
  return { source: sourceCount, target: targetCount, copied }
}

export default function (cli: CLI) {
  cli
    .command('database:import-legacy', 'Resume and verify the one-time SQLite to Vitess data import')
    .option('--source <source>', 'Path to the read-only legacy SQLite database')
    .option('--batch-size <batchSize>', 'Maximum rows per Vitess insert', { default: 250 })
    .option('--verify-only', 'Compare row counts without writing', { default: false })
    .action(async (options: ImportOptions) => {
      const connection = String(process.env.DB_CONNECTION || '').toLowerCase()
      if (connection !== 'vitess' && connection !== 'mysql')
        throw new Error('database:import-legacy requires DB_CONNECTION=vitess or mysql')

      const configuredSource = options.source || resolveDbPath()
      const sourcePath = isAbsolute(configuredSource) ? configuredSource : join(process.cwd(), configuredSource)
      if (!existsSync(sourcePath)) throw new Error(`Legacy SQLite database not found: ${sourcePath}`)
      const batchSize = Number(options.batchSize ?? 250)
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000)
        throw new Error('--batch-size must be an integer between 1 and 5000')

      const source = new SqliteDatabase(sourcePath, { readonly: true })
      const target = new TargetDatabase()
      let copied = 0
      let verified = 0
      try {
        for (const table of targetTables()) {
          const result = await importTable(source, target, table, batchSize, Boolean(options.verifyOnly))
          copied += result.copied
          verified += result.source
          if (result.source > 0)
            log.info(`${table}: SQLite ${result.source}, Vitess ${result.target}`)
        }
      }
      finally {
        source.close()
        target.close()
      }

      log.success(`${options.verifyOnly ? 'Verified' : 'Imported'} ${verified} legacy rows${options.verifyOnly ? '' : ` (${copied} processed)`}.`)
    })
}
