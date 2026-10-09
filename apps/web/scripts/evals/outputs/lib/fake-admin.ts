// A table-to-rows stand-in for the Supabase client, enough for the evals to run
// agents and digest assembly without a database. Rows may carry nested objects
// where the real query would join. Writes land in the same tables.

import type { AdminClient } from '@/lib/harness/types'

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

function get(row: Row, col: string): unknown {
  return col.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Row)[k] : undefined), row)
}

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((r: Row) => boolean)[] = []
  private orders: { col: string; asc: boolean }[] = []
  private max = Infinity
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  private payload: Row | Row[] | null = null
  private one = false

  constructor(
    private tables: Tables,
    private table: string
  ) {}

  select(): this {
    return this
  }
  eq(col: string, v: unknown): this {
    this.filters.push((r) => get(r, col) === v)
    return this
  }
  neq(col: string, v: unknown): this {
    this.filters.push((r) => get(r, col) !== v)
    return this
  }
  in(col: string, vs: unknown[]): this {
    this.filters.push((r) => vs.includes(get(r, col)))
    return this
  }
  is(col: string, v: unknown): this {
    this.filters.push((r) => (get(r, col) ?? null) === v)
    return this
  }
  not(col: string, op: string, v: unknown): this {
    if (op === 'is') this.filters.push((r) => (get(r, col) ?? null) !== v)
    return this
  }
  gte(col: string, v: unknown): this {
    this.filters.push((r) => String(get(r, col) ?? '') >= String(v))
    return this
  }
  lte(col: string, v: unknown): this {
    this.filters.push((r) => String(get(r, col) ?? '') <= String(v))
    return this
  }
  gt(col: string, v: unknown): this {
    this.filters.push((r) => String(get(r, col) ?? '') > String(v))
    return this
  }
  lt(col: string, v: unknown): this {
    this.filters.push((r) => String(get(r, col) ?? '') < String(v))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: opts?.ascending !== false })
    return this
  }
  limit(n: number): this {
    this.max = n
    return this
  }
  single(): this {
    this.one = true
    return this
  }
  maybeSingle(): this {
    this.one = true
    return this
  }
  insert(p: Row | Row[]): this {
    this.mode = 'insert'
    this.payload = p
    return this
  }
  upsert(p: Row | Row[]): this {
    this.mode = 'upsert'
    this.payload = p
    return this
  }
  update(p: Row): this {
    this.mode = 'update'
    this.payload = p
    return this
  }
  delete(): this {
    this.mode = 'delete'
    return this
  }

  private run(): { data: unknown; error: null } {
    const rows = (this.tables[this.table] ??= [])
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const added = (Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]).map((p) => ({ id: `row-${rows.length + 1}`, ...p }))
      rows.push(...added)
      return { data: this.one ? added[0] : added, error: null }
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.mode === 'update') {
      for (const r of hit) Object.assign(r, this.payload)
      return { data: hit, error: null }
    }
    if (this.mode === 'delete') {
      this.tables[this.table] = rows.filter((r) => !hit.includes(r))
      return { data: hit, error: null }
    }
    for (const { col, asc } of [...this.orders].reverse()) {
      hit = [...hit].sort((a, b) => {
        const x = get(a, col) as string | number | null
        const y = get(b, col) as string | number | null
        if (x === y) return 0
        if (x == null) return 1
        if (y == null) return -1
        return (x < y ? -1 : 1) * (asc ? 1 : -1)
      })
    }
    hit = hit.slice(0, this.max)
    return { data: this.one ? (hit[0] ?? null) : hit, error: null }
  }

  then<T1 = { data: unknown; error: null }, T2 = never>(
    onfulfilled?: ((v: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

export function fakeAdmin(tables: Tables = {}): AdminClient & { tables: Tables } {
  return { tables, from: (t: string) => new Query(tables, t) } as unknown as AdminClient & { tables: Tables }
}
