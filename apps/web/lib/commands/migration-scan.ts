// Reads supabase/migrations as text and answers "which public tables hold a
// person's rows by user_id". Two tests use it: the owned-tables list and the
// provenance table list. It follows create table, add column user_id and drop
// table in version order. A table a migration builds with format() inside a do
// block is invisible to it, which is why those migrations name their tables
// plainly.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations')

/** Drops comments but keeps '...' literals whole, so a -- inside a string does not
 *  swallow the line. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === "'" ? m : ' '))
}

/** The text between the parentheses that open at `from`, balanced. */
function balanced(sql: string, from: number): string {
  let depth = 1
  let i = from
  while (depth > 0 && i < sql.length) {
    const c = sql[i]
    if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    i += 1
  }
  return sql.slice(from, i - 1)
}

/** Table names that hold a `user_id` column after every migration in `files` ran,
 *  in version order. */
export function userIdTables(files: { name: string; sql: string }[]): Set<string> {
  const tables = new Set<string>()
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const sql = stripSqlComments(file.sql)
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi)) {
      const body = balanced(sql, (m.index ?? 0) + m[0].length)
      if (/(^|[\s,(])user_id\s+(uuid|text)/i.test(body)) tables.add(m[1])
    }
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?user_id\b/gi
    )) {
      tables.add(m[1])
    }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      tables.delete(m[1])
    }
  }
  return tables
}

/** Table names that carry an `origin` column: created with one, given one by
 *  add column, or named in the array a looping migration adds it to. */
export function originTables(files: { name: string; sql: string }[]): Set<string> {
  const tables = new Set<string>()
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const sql = stripSqlComments(file.sql)
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi)) {
      const body = balanced(sql, (m.index ?? 0) + m[0].length)
      if (/(^|[\s,(])origin\s+text/i.test(body)) tables.add(m[1])
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?origin\b/gi)) {
      tables.add(m[1])
    }
    // A migration that loops over a list of tables: foreach t in array array['a', 'b'] ... add column ... origin.
    if (/add column if not exists origin text/i.test(sql)) {
      const list = sql.match(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]/i)?.[1] ?? ''
      for (const m of list.matchAll(/'(\w+)'/g)) tables.add(m[1])
    }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) tables.delete(m[1])
  }
  return tables
}

export function originTablesInRepo(): Set<string> {
  return originTables(readMigrations())
}

export function readMigrations(dir: string = MIGRATIONS_DIR): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }))
}

export function userIdTablesInRepo(): Set<string> {
  return userIdTables(readMigrations())
}
