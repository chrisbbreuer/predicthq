import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * Build a throwaway database from the real migration files.
 *
 * Tests resolve migrations by table name rather than by filename. The
 * generator renumbers files whenever the model set changes, so a
 * hardcoded `0000000207-create-prediction_markets-table.sql` is a test
 * that breaks on an unrelated migration — which is exactly what
 * happened, and what this exists to stop happening again.
 *
 * Index migrations are applied too: several of the queries under test
 * are only correct because of a unique index, and a schema without them
 * passes tests the real database would fail.
 */

const MIGRATIONS_DIR = 'database/migrations'

/**
 * Every migration file that creates the named table or an index on it,
 * in the order the runner would apply them.
 */
export function migrationsFor(tables: string[]): string[] {
  const dir = join(process.cwd(), MIGRATIONS_DIR)
  const wanted = new Set(tables)

  return readdirSync(dir)
    .filter((file) => {
      if (!file.endsWith('.sql'))
        return false

      const createTable = file.match(/^\d+-create-(.+)-table\.sql$/)
      if (createTable?.[1] && wanted.has(createTable[1]))
        return true

      // Alters, too. The generator emits a column addition as its own
      // `alter` file rather than by rewriting the create, so matching
      // only creates builds a schema frozen at whenever the table was
      // first added. A test then passes against a shape the real
      // database has not had for months, which is the same class of
      // breakage the name-based lookup above exists to prevent.
      const alterTable = file.match(/^\d+-alter-(.+?)-[a-z]+\.sql$/)
      if (alterTable?.[1] && wanted.has(alterTable[1]))
        return true

      const createIndex = file.match(/-index-in-(.+)\.sql$/)
      if (createIndex?.[1] && wanted.has(createIndex[1]))
        return true

      // Everything the generator cannot name after a single table lands
      // in a miscellaneous file — a dropped index, most often. Its name
      // says nothing about what it touches, so it is matched on its
      // contents instead. Skipping these builds a schema that still has
      // constraints production dropped, and a uniqueness the app no
      // longer relies on is a test that passes for the wrong reason.
      return /^\d+-auto-/.test(file) && statementsFor(join(dir, file), wanted).length > 0
    })
    .sort()
    .map(file => join(dir, file))
}

/**
 * The statements in a file that concern one of the wanted tables.
 *
 * A miscellaneous migration may touch tables a given test never creates,
 * and running those would fail on a table that does not exist. Selecting
 * by mention keeps each test's schema to the tables it asked for.
 */
function statementsFor(path: string, wanted: Set<string>): string[] {
  return readFileSync(path, 'utf-8')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0)
    .filter(statement => [...wanted].some(table => statement.includes(table)))
}

/** A database with those tables, created and indexed. */
export function schemaFor(path: string, tables: string[]): Database {
  /*
   * Every caller writes into `tests/temp`, which is gitignored - so it exists
   * on a machine that has run the suite before, and nowhere else. A fresh
   * clone and a CI runner are the same case: the directory is absent, and
   * `new Database(path)` fails with SQLITE_CANTOPEN before a single assertion
   * runs. That took out 83 of 436 tests, which is to say every test that
   * needs a database rather than any particular one.
   *
   * Created here rather than in each test file because there are eight call
   * sites and the next one added would rediscover this the hard way.
   */
  mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path)
  const wanted = new Set(tables)

  for (const file of migrationsFor(tables)) {
    if (/\/\d+-auto-/.test(file)) {
      for (const statement of statementsFor(file, wanted))
        db.exec(statement)

      continue
    }

    db.exec(readFileSync(file, 'utf-8'))
  }

  // Application queries are asynchronous in production because Vitess is
  // reached over the MySQL protocol. Keep schema setup and assertions on the
  // real SQLite handle, while exposing the same transaction/upsert surface
  // the application uses. Awaiting SQLite's synchronous statement results is
  // valid and keeps these tests focused on query behaviour rather than mocks.
  Object.assign(db, {
    async transaction<T>(fn: (transaction: Database) => Promise<T> | T): Promise<T> {
      db.exec('BEGIN')
      try {
        const result = await fn(db)
        db.exec('COMMIT')
        return result
      }
      catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async updateOrInsert(table: string, match: Record<string, unknown>, values: Record<string, unknown>): Promise<void> {
      const matchColumns = Object.keys(match)
      const existing = db.query(
        `SELECT 1 FROM ${table} WHERE ${matchColumns.map(column => `${column} = ?`).join(' AND ')} LIMIT 1`,
      ).get(...Object.values(match))

      if (existing) {
        const valueColumns = Object.keys(values)
        db.query(
          `UPDATE ${table} SET ${valueColumns.map(column => `${column} = ?`).join(', ')} WHERE ${matchColumns.map(column => `${column} = ?`).join(' AND ')}`,
        ).run(...Object.values(values), ...Object.values(match))
        return
      }

      const insert = { ...match, ...values }
      const columns = Object.keys(insert)
      db.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...Object.values(insert))
    },
    async insertOrIgnore(table: string, values: Record<string, unknown>): Promise<void> {
      const columns = Object.keys(values)
      db.query(
        `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...Object.values(values))
    },
    /**
     * The multi-row upsert the driver gives us in production.
     *
     * SQLite and Postgres spell it `ON CONFLICT`, MySQL and Vitess spell it
     * `ON DUPLICATE KEY UPDATE`, and the driver picks. Only the SQLite form
     * is needed here, but the *semantics* have to match or these tests
     * would prove something production does not do: an empty merge list is
     * the do-nothing form, and the affected-row count is how many rows
     * actually landed.
     */
    async upsert(
      table: string,
      rows: Record<string, unknown>[],
      conflictColumns: string[],
      mergeColumns: string[] = [],
    ): Promise<{ changes: number, lastInsertRowid: number }> {
      if (rows.length === 0)
        return { changes: 0, lastInsertRowid: 0 }

      const columns = Object.keys(rows[0]!)
      const tuple = `(${columns.map(() => '?').join(', ')})`
      const values = rows.map(() => tuple).join(', ')
      const params = rows.flatMap(row => columns.map(column => row[column] as unknown))
      const target = conflictColumns.join(', ')

      const resolution = mergeColumns.length === 0
        ? 'DO NOTHING'
        : `DO UPDATE SET ${mergeColumns.map(column => `${column} = excluded.${column}`).join(', ')}`

      return db.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values} ON CONFLICT (${target}) ${resolution}`,
      ).run(...params) as { changes: number, lastInsertRowid: number }
    },
  })

  return db
}
