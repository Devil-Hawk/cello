// One clock. Nothing else in the repository schedules work: no `schedule:` in a workflow, no crons in
// vercel.json, and every job the old harness cron did is a routine row in the clock migration.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWANCE_MS } from './meter'

const ROOT = path.resolve(__dirname, '../../../..')
const migration = readFileSync(path.join(ROOT, 'supabase/migrations/20261008040000_clock.sql'), 'utf8')
// The handler map's source: importing it would load the whole harness.
const handlers = readFileSync(path.join(__dirname, 'routines/index.ts'), 'utf8')

describe('the clock is the only schedule', () => {
  it('has no schedule: in any workflow', () => {
    const dir = path.join(ROOT, '.github/workflows')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
      const text = readFileSync(path.join(dir, f), 'utf8')
      const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
      expect(code, `${f} must not schedule anything`).not.toMatch(/^\s*schedule:/m)
      expect(code, `${f} must not have a cron line`).not.toMatch(/^\s*-\s*cron:/m)
    }
  })

  it('has no crons in vercel.json', () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'apps/web/vercel.json'), 'utf8')) as { crons?: unknown }
    expect(config.crons).toBeUndefined()
  })

  it('has deleted the harness cron workflow and route', () => {
    expect(existsSync(path.join(ROOT, '.github/workflows/harness-cron.yml'))).toBe(false)
    expect(existsSync(path.join(ROOT, 'apps/web/app/api/harness/cron/route.ts'))).toBe(false)
  })

  it('has a routine row for every job the harness cron did, and a handler for each', () => {
    const jobs: Record<string, string> = {
      'resume of paused and stale runs': 'harness.resume',
      'demo wipe': 'demo.expire',
      'trace prune': 'demo.expire',
      'digest runs': 'harness.digest',
      'digest compose': 'harness.digest',
      'learn from your record': 'harness.learn',
    }
    for (const [job, command] of Object.entries(jobs)) {
      expect(migration, `${job} needs the ${command} routine`).toContain(`'${command}'`)
      expect(handlers, `${command} needs a handler`).toContain(`'${command}':`)
    }
    // and the clock's own: the person's check, mail, health, the meter and prune
    for (const command of ['roles.check', 'inbox.sync', 'owner.health', 'clock.meter', 'clock.prune']) {
      expect(migration).toContain(`'${command}'`)
      expect(handlers).toContain(`'${command}':`)
    }
  })

  it('ships the rendered dispatch off', () => {
    expect(migration).toMatch(/'roles\.render',\s+null,\s+null,\s+'UTC',\s+null,\s+false/)
  })

  it('keeps the meter allowance in the code equal to the one in the database', () => {
    const m = /clock_allowance_ms\(\)[\s\S]*?select (\d+)::bigint/.exec(migration)
    expect(Number(m?.[1])).toBe(ALLOWANCE_MS)
  })

  it('schedules the minute sweeper only in the post-deploy migration', () => {
    const post = readFileSync(path.join(ROOT, 'supabase/migrations/20261008040001_clock_schedule.sql'), 'utf8')
    expect(post).toContain("cron.schedule('cello-agent-sweep', '* * * * *'")
    expect(migration).not.toMatch(/cron\.schedule\(/)
  })
})
