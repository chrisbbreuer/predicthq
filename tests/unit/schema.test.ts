/**
 * The Vitess schema audit.
 *
 * Exists because the migration generator picks its DDL profile from
 * `DB_VITESS_SHARDED` and assumes sharded when the variable is absent —
 * so a run from a shell that happens not to have it set emits tables
 * with no way to allocate an id, in a file that reads exactly like the
 * correct one. This is the check that finds it before an insert does.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { auditVitessMigrations, configuredKeyspaceIsSharded, keyspaceIsSharded } from '../../app/Services/schema'

let root: string

function migration(name: string, sql: string): void {
  writeFileSync(join(root, 'database/migrations/vitess', name), sql)
}

const UNSHARDED = `CREATE TABLE IF NOT EXISTS \`things\` (
  \`id\` bigint PRIMARY KEY auto_increment,
  \`name\` varchar(80)
);`

const SHARDED = `CREATE TABLE IF NOT EXISTS \`things\` (
  \`id\` bigint PRIMARY KEY,
  \`name\` varchar(80)
);`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'predicthq-schema-'))
  mkdirSync(join(root, 'database/migrations/vitess'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reading the sharding flag', () => {
  it('assumes sharded when nobody said', () => {
    // The dangerous default, pinned here so a change to it is deliberate.
    expect(keyspaceIsSharded(undefined)).toBe(true)
    expect(keyspaceIsSharded('')).toBe(true)
  })

  it('reads the obvious negatives as unsharded', () => {
    for (const value of ['false', '0', 'no', 'off', ' FALSE '])
      expect(keyspaceIsSharded(value)).toBe(false)
  })

  it('reads anything else as sharded', () => {
    expect(keyspaceIsSharded('true')).toBe(true)
  })
})

/**
 * The environment-reading half, pinned separately.
 *
 * These set the variable rather than trusting whatever the developer's
 * `.env` happens to hold. `.env.example` ships `DB_VITESS_SHARDED=false`,
 * so a suite that read the ambient value would pass or fail depending on
 * whether the person running it had copied that file — which is how the
 * absent-value case above used to break on a fresh checkout.
 */
describe('reading the sharding flag from the environment', () => {
  const original = process.env.DB_VITESS_SHARDED

  afterEach(() => {
    if (original === undefined)
      delete process.env.DB_VITESS_SHARDED
    else
      process.env.DB_VITESS_SHARDED = original
  })

  it('assumes sharded when the variable is absent', () => {
    delete process.env.DB_VITESS_SHARDED

    expect(configuredKeyspaceIsSharded()).toBe(true)
  })

  it('takes the variable at its word when it is set', () => {
    process.env.DB_VITESS_SHARDED = 'false'
    expect(configuredKeyspaceIsSharded()).toBe(false)

    process.env.DB_VITESS_SHARDED = 'true'
    expect(configuredKeyspaceIsSharded()).toBe(true)
  })
})

describe('auditing the migrations', () => {
  it('passes matching DDL on an unsharded keyspace', () => {
    migration('0000000001-create-things-table.sql', UNSHARDED)

    expect(auditVitessMigrations(root, false)).toHaveLength(0)
  })

  it('catches a table with no way to allocate an id', () => {
    migration('0000000001-create-things-table.sql', SHARDED)

    const [problem] = auditVitessMigrations(root, false)

    expect(problem!.table).toBe('things')
    expect(problem!.detail).toContain('every insert will fail')
  })

  it('catches AUTO_INCREMENT on a sharded keyspace', () => {
    migration('0000000001-create-things-table.sql', UNSHARDED)

    const [problem] = auditVitessMigrations(root, true)

    expect(problem!.detail).toContain('sharded keyspace rejects')
  })

  it('ignores a table with no id of its own', () => {
    // A pivot keyed on its two foreign keys allocates nothing, so it has
    // nothing to get wrong.
    migration('0000000001-create-taggables-table.sql', 'CREATE TABLE `taggables` (\n  `tag_id` bigint,\n  `model_id` bigint\n);')

    expect(auditVitessMigrations(root, false)).toHaveLength(0)
  })

  it('says nothing when the project has no Vitess set', () => {
    rmSync(join(root, 'database/migrations/vitess'), { recursive: true })

    expect(auditVitessMigrations(root, false)).toHaveLength(0)
  })
})

describe('the committed migrations', () => {
  it('match the unsharded keyspace this deployment runs', () => {
    // Against the real directory, not a fixture. This is the assertion
    // that would have caught the tables generated under the wrong flag.
    expect(auditVitessMigrations(process.cwd(), false)).toEqual([])
  })
})
