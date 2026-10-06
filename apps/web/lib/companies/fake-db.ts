// In-memory stand-in for the slice of the Supabase query builder these
// modules use. Test support only: nothing in the app imports it.
//
// Supported: select, insert, upsert (onConflict, ignoreDuplicates), update,
// delete, eq, neq, in, lt, gt, is, ilike (trailing % only), or('a.eq.x,b.eq.y'), order, limit,
// maybeSingle, single, rpc. Filters and writes behave like Postgres for the
// cases the tests exercise, including unique-constraint violations (23505).

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeDbOptions {
  /** Columns that make a row unique, per table (a violated insert answers 23505). */
  unique?: Record<string, string[][]>
  /** Tables whose rows get a generated id when they have none. */
  autoId?: string[]
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>
}

export interface RecordedQuery {
  table: string
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete'
  filters: string[]
}

export function fakeDb(seed: Record<string, Row[]> = {}, options: FakeDbOptions = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }))
  const queries: RecordedQuery[] = []
  const autoId = new Set(options.autoId ?? ['companies', 'company_suggestions', 'company_directory', 'directory_candidates'])
  let counter = 0

  const rowsOf = (t: string) => (tables[t] ??= [])
  const violates = (t: string, row: Row, ignore?: Row): boolean =>
    (options.unique?.[t] ?? []).some((cols) =>
      rowsOf(t).some((o) => o !== ignore && cols.every((c) => row[c] != null && o[c] === row[c]))
    )

  function builder(table: string) {
    let op: RecordedQuery['op'] = 'select'
    const filters: Filter[] = []
    const filterNames: string[] = []
    let payload: Row | Row[] | null = null
    let conflict: string[] = []
    let ignoreDuplicates = false
    let returning = false
    let order: { col: string; asc: boolean } | null = null
    let max = Infinity
    let single: 'one' | 'maybe' | null = null

    const q: Record<string, unknown> = {}
    const add = (name: string, f: Filter) => {
      filters.push(f)
      filterNames.push(name)
      return q
    }

    let counted = false
    q.select = (_cols?: string, o?: { count?: string; head?: boolean }) => {
      if (op !== 'select') returning = true
      if (o?.count) counted = true
      return q
    }
    q.insert = (p: Row | Row[]) => {
      op = 'insert'
      payload = p
      return q
    }
    q.upsert = (p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      op = 'upsert'
      payload = p
      conflict = (o?.onConflict ?? 'id').split(',').map((s) => s.trim())
      ignoreDuplicates = o?.ignoreDuplicates === true
      return q
    }
    q.update = (p: Row) => {
      op = 'update'
      payload = p
      return q
    }
    q.delete = () => {
      op = 'delete'
      return q
    }
    // A dotted column reads through an embedded row, like PostgREST's `companies.user_id` filter.
    const read = (r: Row, c: string): unknown => (c.includes('.') ? c.split('.').reduce<unknown>((o, k) => (o as Row | undefined)?.[k], r) : r[c])
    q.eq = (c: string, v: unknown) => add(c, (r) => read(r, c) === v)
    q.neq = (c: string, v: unknown) => add(c, (r) => r[c] !== v)
    q.in = (c: string, vs: unknown[]) => add(c, (r) => vs.includes(r[c]))
    q.lt = (c: string, v: unknown) => add(c, (r) => r[c] != null && (r[c] as string | number) < (v as string | number))
    q.gt = (c: string, v: unknown) => add(c, (r) => r[c] != null && (r[c] as string | number) > (v as string | number))
    q.gte = (c: string, v: unknown) => add(c, (r) => r[c] != null && (r[c] as string | number) >= (v as string | number))
    q.lte = (c: string, v: unknown) => add(c, (r) => r[c] != null && (r[c] as string | number) <= (v as string | number))
    q.ilike = (c: string, pattern: string) => {
      const prefix = pattern.replace(/%$/, '').toLowerCase()
      return add(c, (r) => typeof r[c] === 'string' && (r[c] as string).toLowerCase().startsWith(prefix))
    }
    q.like = (c: string, pattern: string) => {
      const prefix = pattern.replace(/%$/, '')
      return add(c, (r) => typeof r[c] === 'string' && (r[c] as string).startsWith(prefix))
    }
    // not('col', 'is', null) is the only form the directory reads use.
    q.not = (c: string, _op: string, v: unknown) => add(c, (r) => (v === null ? r[c] != null : r[c] !== v))
    q.is = (c: string, v: unknown) => add(c, (r) => (v === null ? r[c] == null : r[c] === v))
    q.or = (expr: string) => {
      const parts = expr.split(',').map((p) => p.split('.'))
      return add(
        parts.map((p) => p[0]).join('|'),
        (r) => parts.some(([c, o, ...v]) => o === 'eq' && r[c] === v.join('.'))
      )
    }
    q.order = (col: string, o?: { ascending?: boolean }) => {
      order = { col, asc: o?.ascending !== false }
      return q
    }
    q.limit = (n: number) => {
      max = n
      return q
    }
    q.maybeSingle = () => {
      single = 'maybe'
      return q
    }
    q.single = () => {
      single = 'one'
      return q
    }

    function run(): { data: unknown; error: { message: string; code?: string } | null } {
      queries.push({ table, op, filters: filterNames })
      const all = rowsOf(table)
      const touched: Row[] = []
      if (op === 'insert' || op === 'upsert') {
        for (const raw of Array.isArray(payload) ? (payload as Row[]) : [payload as Row]) {
          const row: Row = { ...raw }
          if (autoId.has(table) && row.id === undefined) row.id = `${table}-${++counter}`
          if (op === 'upsert') {
            const existing = all.find((o) => conflict.every((c) => o[c] === row[c]))
            if (existing) {
              if (!ignoreDuplicates) {
                Object.assign(existing, raw)
                touched.push(existing)
              }
              continue
            }
          } else if (violates(table, row)) {
            return { data: null, error: { message: `duplicate key value violates unique constraint on ${table}`, code: '23505' } }
          }
          all.push(row)
          touched.push(row)
        }
      } else if (op === 'update') {
        for (const r of all.filter((x) => filters.every((f) => f(x)))) {
          Object.assign(r, payload as Row)
          touched.push(r)
        }
      } else if (op === 'delete') {
        const keep = all.filter((x) => !filters.every((f) => f(x)))
        touched.push(...all.filter((x) => !keep.includes(x)))
        tables[table] = keep
      } else {
        let rows = all.filter((x) => filters.every((f) => f(x)))
        if (order) {
          const { col, asc } = order
          rows = [...rows].sort((a, b) => {
            const x = a[col] as string | number
            const y = b[col] as string | number
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1)
          })
        }
        touched.push(...rows.slice(0, max))
        if (counted) return { data: null, count: rows.length, error: null } as never
      }
      if (op !== 'select' && !returning) return { data: null, error: null }
      const out = touched.map((r) => ({ ...r }))
      if (single === 'maybe') return { data: out[0] ?? null, error: null }
      if (single === 'one') {
        return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } }
      }
      return { data: out, error: null }
    }

    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(run()).then(resolve, reject)
      } catch (e) {
        return Promise.reject(e).then(resolve, reject)
      }
    }
    return q
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      // companies_follow, as the database does it: the person's own rows, followed or not.
      if (name === 'companies_follow' && !options.rpc?.[name]) {
        const ids = args.p_ids as string[]
        let changed = 0
        for (const r of rowsOf('companies')) {
          if (ids.includes(r.id as string) && r.user_id === args.p_user && Boolean(r.watching) !== args.p_on) {
            r.watching = args.p_on
            r.followed_at = args.p_on ? '2026-10-13T00:00:00Z' : null
            changed++
          }
        }
        return { data: { ok: true, changed }, error: null }
      }
      const fn = options.rpc?.[name]
      if (!fn) return { data: null, error: { message: `unknown rpc ${name}` } }
      return { data: fn(args), error: null }
    },
  }
  return { client: client as never, tables, queries }
}
