// An in-memory stand-in for the service-role Supabase client, for tests of the
// code in lib/agents that reads and writes tables. It implements the part of the
// query builder this code uses (select, insert, update, delete, upsert, filters,
// order, limit, range, single, maybeSingle, rpc) and honours unique constraints,
// so a "second call returns the first row" test is a real test. Every await is a
// real yield, so two calls started together interleave the way two requests do:
// code that reads, then writes, then reads again is exposed, and a single
// conditional update is not.

import { randomUUID } from 'node:crypto'
import type { AdminClient } from '@/lib/harness/types'

type Row = Record<string, unknown>

export interface TableConfig {
  /** Column groups that must be unique, e.g. [['user_id', 'idempotency_key']]. Null parts never conflict. */
  unique?: string[][]
  /** Columns filled in on insert when absent. */
  defaults?: (row: Row) => Row
}

type RpcHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

export interface FakeAdmin extends AdminClient {
  tables: Record<string, Row[]>
  /** Every operation in order, e.g. 'update approvals'. */
  log: string[]
  rpcHandlers: Record<string, RpcHandler>
}

type Filter = (r: Row) => boolean

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A column value; "companies.user_id" reads through an embedded relation. */
function cell(r: Row, col: string): unknown {
  if (!col.includes('.')) return r[col]
  return col.split('.').reduce<unknown>((o, k) => (Array.isArray(o) ? (o[0] as Row | undefined)?.[k] : (o as Row | undefined)?.[k]), r)
}

export function makeFakeAdmin(seed: Record<string, Row[]> = {}, config: Record<string, TableConfig> = {}): FakeAdmin {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }))
  const log: string[] = []
  const rpcHandlers: Record<string, RpcHandler> = {}

  const table = (name: string): Row[] => (tables[name] ??= [])

  function builder(name: string) {
    const filters: Filter[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row | Row[] | null = null
    let order: { col: string; asc: boolean } | null = null
    let from = 0
    let to: number | null = null
    let single: 'single' | 'maybe' | null = null
    let wantCount = false
    let head = false
    let returning = false
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}

    const matches = (r: Row) => filters.every((f) => f(r))

    function conflicts(candidate: Row, ignore?: Row): boolean {
      const groups = config[name]?.unique ?? []
      return table(name).some(
        (existing) =>
          existing !== ignore &&
          groups.some((cols) => cols.every((c) => candidate[c] != null && existing[c] === candidate[c]))
      )
    }

    async function exec(): Promise<{ data: unknown; error: { message: string; code?: string } | null; count?: number }> {
      log.push(`${op} ${name}`)
      await tick()
      const rows = table(name)
      if (op === 'insert' || op === 'upsert') {
        const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[]
        const created: Row[] = []
        for (const raw of incoming) {
          const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...config[name]?.defaults?.(raw), ...raw }
          if (conflicts(row)) {
            if (op === 'upsert') {
              const key = upsertOpts.onConflict?.split(',').map((s) => s.trim()) ?? ['id']
              const existing = rows.find((e) => key.every((c) => e[c] === row[c]))
              if (existing && !upsertOpts.ignoreDuplicates) {
                Object.assign(existing, raw)
                created.push(existing)
              }
              continue
            }
            return { data: null, error: { message: `duplicate key value violates unique constraint on ${name}`, code: '23505' } }
          }
          rows.push(row)
          created.push(row)
        }
        return finish(returning ? created : null)
      }
      if (op === 'update') {
        const hit = rows.filter(matches)
        for (const r of hit) Object.assign(r, payload)
        return finish(returning ? hit : null)
      }
      if (op === 'delete') {
        const hit = rows.filter(matches)
        tables[name] = rows.filter((r) => !hit.includes(r))
        return finish(returning ? hit : null)
      }
      let result = rows.filter(matches)
      if (order) {
        const { col, asc } = order
        result = [...result].sort((a, b) => {
          const av = a[col] as string | number | null
          const bv = b[col] as string | number | null
          if (av === bv) return 0
          if (av == null) return asc ? -1 : 1
          if (bv == null) return asc ? 1 : -1
          return (av < bv ? -1 : 1) * (asc ? 1 : -1)
        })
      }
      const total = result.length
      result = result.slice(from, to == null ? undefined : to + 1)
      return finish(result, total)
    }

    function finish(rowsOut: Row[] | null, total?: number) {
      const count = wantCount ? (total ?? rowsOut?.length ?? 0) : undefined
      if (head) return { data: null, error: null, count }
      if (rowsOut == null) return { data: null, error: null, count }
      const copy = rowsOut.map((r) => ({ ...r }))
      if (single === 'single') {
        if (copy.length !== 1) return { data: null, error: { message: `Expected one row, got ${copy.length}`, code: 'PGRST116' }, count }
        return { data: copy[0], error: null, count }
      }
      if (single === 'maybe') return { data: copy[0] ?? null, error: null, count }
      return { data: copy, error: null, count }
    }

    const api = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op === 'select') op = 'select'
        else returning = true
        if (opts?.count) wantCount = true
        if (opts?.head) head = true
        return api
      },
      insert(p: Row | Row[]) {
        op = 'insert'
        payload = p
        return api
      },
      upsert(p: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = 'upsert'
        payload = p
        upsertOpts = opts ?? {}
        return api
      },
      update(p: Row) {
        op = 'update'
        payload = p
        return api
      },
      delete() {
        op = 'delete'
        return api
      },
      eq(col: string, v: unknown) {
        filters.push((r) => cell(r, col) === v)
        return api
      },
      neq(col: string, v: unknown) {
        filters.push((r) => cell(r, col) !== v)
        return api
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(cell(r, col)))
        return api
      },
      is(col: string, v: null | boolean) {
        filters.push((r) => (v === null ? cell(r, col) == null : cell(r, col) === v))
        return api
      },
      not(col: string, operator: string, v: unknown) {
        if (operator === 'is') filters.push((r) => (v === null ? r[col] != null : r[col] !== v))
        return api
      },
      lt(col: string, v: string | number) {
        filters.push((r) => r[col] != null && (r[col] as string | number) < v)
        return api
      },
      lte(col: string, v: string | number) {
        filters.push((r) => r[col] != null && (r[col] as string | number) <= v)
        return api
      },
      gt(col: string, v: string | number) {
        filters.push((r) => r[col] != null && (r[col] as string | number) > v)
        return api
      },
      gte(col: string, v: string | number) {
        filters.push((r) => r[col] != null && (r[col] as string | number) >= v)
        return api
      },
      /** A PostgREST filter string such as "lease_until.is.null,lease_until.lt.2026-10-05T00:00:00Z". */
      or(expr: string) {
        const parts = expr.split(',').map((p) => {
          const [col, op, ...rest] = p.split('.')
          return { col, op, value: rest.join('.') }
        })
        filters.push((r) =>
          parts.some(({ col, op, value }) => {
            const v = cell(r, col)
            if (op === 'is') return value === 'null' ? v == null : String(v) === value
            if (op === 'eq') return String(v) === value
            if (v == null) return false
            if (op === 'lt') return String(v) < value
            if (op === 'lte') return String(v) <= value
            if (op === 'gt') return String(v) > value
            if (op === 'gte') return String(v) >= value
            return false
          })
        )
        return api
      },
      order(col: string, opts?: { ascending?: boolean }) {
        order = { col, asc: opts?.ascending ?? true }
        return api
      },
      limit(n: number) {
        to = from + n - 1
        return api
      },
      range(a: number, b: number) {
        from = a
        to = b
        return api
      },
      single() {
        single = 'single'
        return api
      },
      maybeSingle() {
        single = 'maybe'
        return api
      },
      then<T>(resolve: (v: Awaited<ReturnType<typeof exec>>) => T, reject?: (e: unknown) => T) {
        return exec().then(resolve, reject)
      },
    }
    return api
  }

  const admin = {
    tables,
    log,
    rpcHandlers,
    from: (name: string) => builder(name),
    async rpc(name: string, args: Record<string, unknown>) {
      log.push(`rpc ${name}`)
      await tick()
      const handler = rpcHandlers[name]
      if (!handler) return { data: null, error: { message: `no handler for rpc ${name}` } }
      try {
        return { data: await handler(args), error: null }
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }
      }
    },
  }
  // Tables is re-pointed on delete; expose it through a getter so tests always see the live arrays.
  Object.defineProperty(admin, 'tables', { get: () => tables })
  return admin as unknown as FakeAdmin
}
