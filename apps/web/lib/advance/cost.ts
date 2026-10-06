// What an application cost to prepare, and what to do when a model says "too many requests".
// Free and local calls write $0 rows and are counted apart, so the line can say "Free".

export interface CostRow {
  cost_usd: number | null
  free_model: boolean | null
}

export interface Cost {
  usd: number
  free: number
  paid: number
}

export function sumCost(rows: readonly CostRow[]): Cost {
  let usd = 0
  let free = 0
  let paid = 0
  for (const r of rows) {
    if (r.free_model) free++
    else if ((r.cost_usd ?? 0) > 0) paid++
    usd += r.cost_usd ?? 0
  }
  return { usd: Math.round(usd * 10_000) / 10_000, free, paid }
}

/** What the person reads next to an application. */
export function costLine(c: Cost): string {
  if (c.paid === 0) return c.free > 0 ? 'Free' : ''
  return `$${c.usd.toFixed(2)}`
}

export type RateLimit = 'daily' | 'minute'

/** A 429 from a model door: the free daily allowance, or a per-minute wait. Anything else is not one. */
export function rateLimitOf(err: unknown): RateLimit | null {
  const e = err as { status?: number; message?: string } | null
  const text = String(e?.message ?? '')
  if (e?.status !== 429 && !/\b429\b|rate limit/i.test(text)) return null
  return /per-day|daily|free-models-per-day/i.test(text) ? 'daily' : 'minute'
}

/** Where a rate-limited application waits: a minute for the per-minute limit, tomorrow for the daily one. */
export function waitAfter(limit: RateLimit, now: Date): { nextAt: string; sentence: string } {
  if (limit === 'minute') return { nextAt: new Date(now.getTime() + 60_000).toISOString(), sentence: 'The model asked Cello to wait a minute. It will carry on.' }
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5))
  return { nextAt: tomorrow.toISOString(), sentence: 'The free model\'s daily limit is reached. Cello will carry on tomorrow.' }
}
