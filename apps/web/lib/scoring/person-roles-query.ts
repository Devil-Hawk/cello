// A list of roles ordered by what the person wants has to start at person_roles:
// PostgREST can order by a column of an embedded table only when the embed is
// to-one, and a job has one person_roles row per person who sees it. So the list
// query is `from('person_roles').select('<verdict>, jobs!inner(<posting>)')` and
// every filter on a posting column goes through the embed (`jobs.<column>`).
//
// The filters the jobs list already uses (openRolesOnly, applyRoleTargets, the
// facet chips) are written for a query that starts at jobs. OnJobs lets them run
// unchanged on this query: it has the same filter methods and puts the embed's
// name in front of the column. Build the query, wrap it, apply the filters to the
// wrapper, then take `.query` back.

/** The filter calls of a PostgREST builder that OnJobs forwards. Loose on purpose: the builder's own types name the table. */
interface FilterBuilder {
  eq(column: string, value: unknown): unknown
  in(column: string, values: readonly string[]): unknown
  gte(column: string, value: unknown): unknown
  ilike(column: string, pattern: string): unknown
  is(column: string, value: unknown): unknown
  not(column: string, operator: string, value: unknown): unknown
  or(filters: string, options?: { referencedTable?: string }): unknown
  textSearch(column: string, query: string, options?: { type?: 'plain' | 'phrase' | 'websearch'; config?: string }): unknown
}

export class OnJobs<Q> {
  private readonly b: FilterBuilder

  constructor(
    readonly query: Q,
    private readonly embed = 'jobs'
  ) {
    this.b = query as unknown as FilterBuilder
  }

  private col(column: string): string {
    return this.embed + '.' + column
  }

  eq(column: string, value: unknown): this {
    this.b.eq(this.col(column), value)
    return this
  }

  in(column: string, values: readonly string[]): this {
    this.b.in(this.col(column), values)
    return this
  }

  gte(column: string, value: unknown): this {
    this.b.gte(this.col(column), value)
    return this
  }

  ilike(column: string, pattern: string): this {
    this.b.ilike(this.col(column), pattern)
    return this
  }

  is(column: string, value: unknown): this {
    this.b.is(this.col(column), value)
    return this
  }

  not(column: string, operator: string, value: unknown): this {
    this.b.not(this.col(column), operator, value)
    return this
  }

  textSearch(column: string, query: string, options?: { type?: 'plain' | 'phrase' | 'websearch'; config?: string }): this {
    this.b.textSearch(this.col(column), query, options)
    return this
  }

  /** The filter string names posting columns; PostgREST resolves them inside the embed. */
  or(filters: string, options?: { referencedTable?: string }): this {
    this.b.or(filters, { referencedTable: options?.referencedTable ?? this.embed })
    return this
  }
}
