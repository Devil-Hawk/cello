// apps/web/vercel.json is what keeps the daily tick (and so the Supabase
// free-plan keep-alive) running with no GitHub dependency. Vercel Hobby
// rejects a cron that fires more than once a day at deploy time, so pin that
// here: a fixed minute and hour with wildcards for the rest.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
  crons?: { path: string; schedule: string }[]
}

describe('vercel.json crons', () => {
  it('schedules the harness cron exactly once a day', () => {
    expect(config.crons).toHaveLength(1)
    const [cron] = config.crons!
    expect(cron.path).toBe('/api/harness/cron')
    expect(cron.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
  })
})
