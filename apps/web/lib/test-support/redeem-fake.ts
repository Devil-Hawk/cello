// An in-memory stand-in for the service-role client, shaped for the redeem route:
// rpc() answers the three Postgres functions the route calls, from() is a small
// PostgREST that records every query with its filters (so a test can assert how
// something was asked, not only the answer), and auth.admin is GoTrue.
//
// The real functions are proven against a real database in
// lib/access/access-codes.db.test.ts; this fake only decides what they answer.

import { vi } from 'vitest'

export interface Filter {
  op: string
  column: string
  value: unknown
}

export interface Query {
  table: string
  op: 'select' | 'update' | 'insert'
  columns?: string
  payload?: Record<string, unknown>
  filters: Filter[]
}

export interface RedeemFakeState {
  /** note_redeem_attempt: true allows, false limits, 'error' simulates a database error. */
  limiter: boolean | 'error'
  /** What redeem_access_code answers; 'error' simulates a database error. */
  redeem: Record<string, unknown> | 'error'
  /** finish_access_code_provisioning's answer. */
  finish: boolean | 'error'
  /** Rows returned for profiles.eq('id', ...). */
  profilesById: Record<string, Record<string, unknown>>
}

export function createRedeemFake() {
  const createUser = vi.fn()
  const generateLink = vi.fn()
  const getUserById = vi.fn()
  const verifyOtp = vi.fn()
  const signOut = vi.fn()
  const seedDemoWorkspace = vi.fn()

  let queries: Query[] = []
  let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const state: RedeemFakeState = { limiter: true, redeem: { status: 'refused' }, finish: true, profilesById: {} }

  function filtered(query: Query, column: string): Filter | undefined {
    return query.filters.find((f) => f.column === column)
  }

  function resolve(query: Query): { data: unknown; error: unknown } {
    if (query.table === 'access_code_events') return { data: [], error: null }
    if (query.table === 'profiles') {
      if (query.op !== 'select') return { data: null, error: null }
      if (filtered(query, 'email')) return { data: [], error: null }
      const id = filtered(query, 'id')?.value as string | undefined
      return { data: (id && state.profilesById[id]) || null, error: null }
    }
    return { data: null, error: null }
  }

  function builder(query: Query) {
    const chain: Record<string, unknown> = {}
    const withFilter = (op: string) => (column: string, value: unknown) => {
      query.filters.push({ op, column, value })
      return chain
    }
    Object.assign(chain, {
      select: (columns?: string) => {
        query.columns = columns
        return chain
      },
      eq: withFilter('eq'),
      is: withFilter('is'),
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const { data, error } = resolve(query)
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(resolve(query)).then(res, rej),
    })
    return chain
  }

  function record(table: string, op: Query['op'], payload?: Record<string, unknown>) {
    const query: Query = { table, op, payload, filters: [] }
    queries.push(query)
    return builder(query)
  }

  const admin = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      if (fn === 'note_redeem_attempt') {
        return state.limiter === 'error' ? { data: null, error: { message: 'down' } } : { data: state.limiter, error: null }
      }
      if (fn === 'redeem_access_code') {
        return state.redeem === 'error' ? { data: null, error: { message: 'down' } } : { data: state.redeem, error: null }
      }
      if (fn === 'finish_access_code_provisioning') {
        return state.finish === 'error' ? { data: null, error: { message: 'down' } } : { data: state.finish, error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
    from(table: string) {
      return {
        select: (columns?: string) => (record(table, 'select') as { select: (c?: string) => unknown }).select(columns),
        update: (payload: Record<string, unknown>) => record(table, 'update', payload),
        insert: (payload: Record<string, unknown>) => record(table, 'insert', payload),
      }
    },
    auth: { admin: { createUser, generateLink, getUserById } },
  }

  return {
    admin,
    state,
    mocks: { createUser, generateLink, getUserById, verifyOtp, signOut, seedDemoWorkspace },
    get queries() {
      return queries
    },
    get rpcCalls() {
      return rpcCalls
    },
    /** Every write the route attempted, for "what reached the database" assertions. */
    writes: () => queries.filter((q) => q.op !== 'select'),
    clear() {
      queries = []
      rpcCalls = []
    },
  }
}
