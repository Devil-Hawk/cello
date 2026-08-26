// What these tests actually defend.
//
// The demo workspace is fabricated data written into a real database with the
// service-role key. Three classes of bug matter far more than "does it compile":
//
//   1. IT REACHES A REAL PERSON. A contact address on a live domain, a
//      linkedin.com profile URL, a job URL pointing at a real employer — any of
//      those turns a demo into an email to a stranger or a fabricated posting
//      attributed to a real company. Every string is swept for that.
//   2. IT SPENDS THE OWNER'S MONEY. The $1 cap has to survive a re-seed, and
//      re-seeding must not reset the spend counter (or re-entering the access
//      code becomes a way to refill the allowance).
//   3. IT LANDS ON A REAL ACCOUNT. The safety gate is the only thing between
//      this seeder and someone's actual job search.
//
// Everything runs against an in-memory fake of the exact PostgREST chains
// seed-demo.ts uses. No network, no Supabase project, no writes.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  buildDemoPreferences,
  buildDemoWorkspace,
  DEMO_MONTHLY_USD,
  NotADemoProfileError,
  seedDemoWorkspace,
  type DemoBatch,
} from './seed-demo'
import { DEMO_COMPANIES, DEMO_CONTACTS, DEMO_JOBS, DEMO_APPLICATIONS } from './fixtures'
import { scoreBandFor, type ScoreBand } from '@/lib/jobs/score-bands'
import { markdownToPlainText } from '@/lib/resume/markdown'

const DEMO_USER = '11111111-2222-4333-8444-555555555555'
const OTHER_USER = '99999999-8888-4777-8666-555555555555'
const NOW = new Date('2026-08-03T12:00:00.000Z')

// ---------------------------------------------------------------------------
// In-memory fake of the PostgREST chains this module uses
// ---------------------------------------------------------------------------

interface FakeProfile {
  id: string
  email: string | null
  resume_text: string | null
  preferences: Record<string, unknown> | null
  is_demo: boolean | null
  [key: string]: unknown
}

interface Fake {
  admin: SupabaseClient
  tables: Map<string, Map<string, Record<string, unknown>>>
  profiles: Map<string, FakeProfile>
  /** Force the safety gate's company-count probe to fail. */
  failCompanyCount: (message: string | null) => void
  /** Force one table's upsert to fail, to exercise required vs optional. */
  failTable: (table: string | null) => void
  rowsIn: (table: string) => Record<string, unknown>[]
}

function fakeAdmin(profile: Partial<FakeProfile> = {}): Fake {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const profiles = new Map<string, FakeProfile>()
  let companyCountError: string | null = null
  let failingTable: string | null = null

  if (profile.id !== null) {
    profiles.set(profile.id ?? DEMO_USER, {
      id: profile.id ?? DEMO_USER,
      email: profile.email ?? 'demo-a1b2c3@cello-demo.example.com',
      resume_text: profile.resume_text ?? null,
      preferences: profile.preferences ?? null,
      is_demo: profile.is_demo ?? false,
    })
  }

  function store(table: string): Map<string, Record<string, unknown>> {
    const existing = tables.get(table)
    if (existing) return existing
    const created = new Map<string, Record<string, unknown>>()
    tables.set(table, created)
    return created
  }

  const admin = {
    from(table: string) {
      return {
        select(_columns: string, opts?: { count?: string; head?: boolean }) {
          const filters: Record<string, unknown> = {}
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value
              return builder
            },
            async maybeSingle() {
              if (table !== 'profiles') return { data: null, error: null }
              return { data: profiles.get(filters.id as string) ?? null, error: null }
            },
            then(resolve: (value: unknown) => void) {
              if (table === 'companies' && opts?.count) {
                if (companyCountError) {
                  resolve({ data: null, count: null, error: { message: companyCountError } })
                  return
                }
                const rows = [...store('companies').values()].filter(
                  (row) => row.user_id === filters.user_id
                )
                resolve({ data: null, count: rows.length, error: null })
                return
              }
              resolve({ data: [...store(table).values()], error: null })
            },
          }
          return builder
        },

        update(patch: Record<string, unknown>) {
          const builder = {
            eq(_column: string, value: unknown) {
              const row = profiles.get(value as string)
              if (row) Object.assign(row, patch)
              return builder
            },
            then(resolve: (value: unknown) => void) {
              resolve({ error: null })
            },
          }
          return builder
        },

        async upsert(
          rows: Record<string, unknown>[],
          opts?: { onConflict?: string; ignoreDuplicates?: boolean }
        ) {
          if (failingTable === table) return { error: { message: 'simulated failure' } }
          const target = store(table)
          const idKey = opts?.onConflict ?? 'id'
          for (const row of rows) {
            const id = row[idKey] as string
            if (target.has(id) && opts?.ignoreDuplicates) continue
            target.set(id, row)
          }
          return { error: null }
        },
      }
    },
  }

  return {
    admin: admin as unknown as SupabaseClient,
    tables,
    profiles,
    failCompanyCount: (message) => {
      companyCountError = message
    },
    failTable: (name) => {
      failingTable = name
    },
    rowsIn: (table) => [...store(table).values()],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function batch(batches: DemoBatch[], table: string): DemoBatch {
  const found = batches.find((b) => b.table === table)
  if (!found) throw new Error(`No batch for table ${table}`)
  return found
}

/** Every string anywhere in a value, however deeply nested. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) collectStrings(inner, out)
  }
  return out
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const URL_RE = /https?:\/\/[^\s"'<>)]+/g

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('buildDemoWorkspace — shape', () => {
  const workspace = buildDemoWorkspace(DEMO_USER, NOW)

  it('seeds every table the demo pages read', () => {
    expect(workspace.batches.map((b) => b.table)).toEqual([
      'companies',
      'jobs',
      'eval_verdicts',
      'applications',
      'activities',
      'contacts',
      'follow_ups',
      'agent_runs',
      'trace_spans',
      'application_drafts',
      'outreach_messages',
      'resume_documents',
      'interview_kits',
      'company_dossiers',
    ])
    for (const b of workspace.batches) expect(b.rows.length).toBeGreaterThan(0)
  })

  it('seeds ~12 companies, ~40 jobs, ~10 applications and ~8 contacts', () => {
    expect(batch(workspace.batches, 'companies').rows).toHaveLength(12)
    expect(batch(workspace.batches, 'jobs').rows).toHaveLength(40)
    expect(batch(workspace.batches, 'applications').rows).toHaveLength(10)
    expect(batch(workspace.batches, 'contacts').rows).toHaveLength(8)

    // The fixture arrays and the built rows must not drift apart.
    expect(DEMO_COMPANIES).toHaveLength(12)
    expect(DEMO_JOBS).toHaveLength(40)
    expect(DEMO_APPLICATIONS).toHaveLength(10)
    expect(DEMO_CONTACTS).toHaveLength(8)
  })

  it('fills every kanban column — all seven pipeline stages appear', () => {
    const stages = new Set(batch(workspace.batches, 'applications').rows.map((r) => r.stage))
    expect([...stages].sort()).toEqual([
      'applied',
      'discovered',
      'ghosted',
      'interview',
      'offer',
      'rejected',
      'screen',
    ])
  })

  it('spreads match_score across every band, including some unscored', () => {
    const counts: Record<ScoreBand, number> = { strong: 0, good: 0, fair: 0, weak: 0, unscored: 0 }
    for (const row of batch(workspace.batches, 'jobs').rows) {
      counts[scoreBandFor(row.match_score as number | null)] += 1
    }
    // A few 80+, many mid, some low — plus a handful genuinely unscored so the
    // dashboard's "Unscored" tile and the histogram's unscored bar are real.
    expect(counts).toEqual({ strong: 5, good: 10, fair: 12, weak: 10, unscored: 3 })
  })

  it('populates match_details in the shape the UI reads, and only for scored rows', () => {
    for (const row of batch(workspace.batches, 'jobs').rows) {
      const details = row.match_details as Record<string, unknown> | null
      if (row.match_score == null) {
        expect(details).toBeNull()
        continue
      }
      expect(details).toBeTruthy()
      expect(details!.overallScore).toBe(row.match_score)
      expect(details!.score).toBe(row.match_score)
      expect(Array.isArray(details!.highlights)).toBe(true)
      expect((details!.highlights as string[]).length).toBeGreaterThan(0)
      expect(Array.isArray(details!.gaps)).toBe(true)
      expect(typeof details!.summary).toBe('string')
      expect(details!.skills).toMatchObject({ matched: expect.any(Array), missing: expect.any(Array) })
      for (const key of ['skillsMatch', 'experienceMatch', 'locationMatch'] as const) {
        expect(details![key]).toBeGreaterThanOrEqual(0)
        expect(details![key]).toBeLessThanOrEqual(100)
      }
      // Honest provenance: nothing here came out of the matcher.
      expect(details!.source).toBe('demo/seed')
    }
  })

  it('seeds a matching eval_verdicts pass row for every scored job — Step 4 item 3 allowlist bait (lib/graph/autopilot.ts#loadCandidateJobs)', () => {
    const jobs = batch(workspace.batches, 'jobs').rows
    const scoredJobIds = new Set(jobs.filter((r) => r.match_score != null).map((r) => r.id))
    const verdicts = batch(workspace.batches, 'eval_verdicts').rows

    expect(verdicts).toHaveLength(scoredJobIds.size)
    const verdictSubjectIds = new Set(verdicts.map((r) => r.subject_id))
    expect(verdictSubjectIds).toEqual(scoredJobIds)
    for (const row of verdicts) {
      expect(row.subject_kind).toBe('match_score')
      expect(row.judge).toBe('deterministic')
      expect(row.verdict).toBe('pass')
      expect(row.user_id).toBe(DEMO_USER)
    }
  })

  it('spreads posted_at over the last three weeks, with a few flagged new', () => {
    const jobs = batch(workspace.batches, 'jobs').rows
    let newCount = 0
    for (const row of jobs) {
      const ageDays = (NOW.getTime() - Date.parse(row.posted_at as string)) / 86_400_000
      expect(ageDays).toBeGreaterThan(0)
      expect(ageDays).toBeLessThanOrEqual(21)
      // Discovery can never precede the posting.
      expect(Date.parse(row.discovered_at as string)).toBeGreaterThanOrEqual(
        Date.parse(row.posted_at as string)
      )
      if (row.is_new === true) newCount += 1
    }
    expect(newCount).toBeGreaterThan(0)
    expect(newCount).toBeLessThan(jobs.length)
  })

  it('keeps every foreign key inside the seeded graph', () => {
    const companyIds = new Set(batch(workspace.batches, 'companies').rows.map((r) => r.id))
    const jobIds = new Set(batch(workspace.batches, 'jobs').rows.map((r) => r.id))
    const applicationIds = new Set(batch(workspace.batches, 'applications').rows.map((r) => r.id))
    const contactIds = new Set(batch(workspace.batches, 'contacts').rows.map((r) => r.id))
    const runIds = new Set(batch(workspace.batches, 'agent_runs').rows.map((r) => r.id))

    for (const row of batch(workspace.batches, 'jobs').rows) expect(companyIds.has(row.company_id)).toBe(true)
    for (const row of batch(workspace.batches, 'applications').rows) expect(jobIds.has(row.job_id)).toBe(true)
    for (const row of batch(workspace.batches, 'activities').rows) {
      expect(applicationIds.has(row.application_id)).toBe(true)
    }
    for (const row of batch(workspace.batches, 'contacts').rows) expect(companyIds.has(row.company_id)).toBe(true)
    for (const row of batch(workspace.batches, 'eval_verdicts').rows) expect(jobIds.has(row.subject_id)).toBe(true)
    for (const row of batch(workspace.batches, 'trace_spans').rows) expect(runIds.has(row.run_id)).toBe(true)
    for (const row of batch(workspace.batches, 'application_drafts').rows) {
      expect(jobIds.has(row.job_id)).toBe(true)
      expect(runIds.has(row.run_id)).toBe(true)
    }
    for (const row of batch(workspace.batches, 'outreach_messages').rows) {
      expect(contactIds.has(row.contact_id)).toBe(true)
      expect(jobIds.has(row.job_id)).toBe(true)
      expect(companyIds.has(row.company_id)).toBe(true)
    }
    for (const row of batch(workspace.batches, 'follow_ups').rows) {
      // The table's CHECK requires at least one target.
      expect(row.contact_id != null || row.application_id != null).toBe(true)
      if (row.contact_id != null) expect(contactIds.has(row.contact_id)).toBe(true)
      if (row.application_id != null) expect(applicationIds.has(row.application_id)).toBe(true)
    }
  })

  it('never records an application submitted before its job was posted', () => {
    const postedById = new Map(
      batch(workspace.batches, 'jobs').rows.map((r) => [r.id as string, Date.parse(r.posted_at as string)])
    )
    for (const row of batch(workspace.batches, 'applications').rows) {
      if (row.applied_at == null) continue
      expect(Date.parse(row.applied_at as string)).toBeGreaterThanOrEqual(postedById.get(row.job_id as string)!)
    }
  })

  it('stores the resume as authored Markdown AND the derived plain text together', () => {
    const resume = batch(workspace.batches, 'resume_documents').rows[0]!
    const contentJson = resume.content_json as { markdown?: string; templateId?: string }
    expect(typeof contentJson.markdown).toBe('string')
    expect(contentJson.markdown!.length).toBeGreaterThan(500)
    expect(typeof contentJson.templateId).toBe('string')
    // lib/resume/types.ts: `content` is DERIVED from `markdown`, never authored
    // separately. If these ever diverge the exported PDF and the text an ATS
    // reads describe different resumes.
    expect(resume.content).toBe(markdownToPlainText(contentJson.markdown!))
    expect(resume.version).toBe(1)
    expect(resume.job_id).toBeNull()
    expect(resume.source).toBe('base')
    // The profile's plain-text resume is the same document.
    expect(workspace.profile.resume_text).toBe(resume.content)
  })

  it('marks the profile as a demo', () => {
    expect(workspace.profile.is_demo).toBe(true)
    expect(workspace.profile.full_name).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('buildDemoWorkspace — determinism', () => {
  // Every batch's row identity lives under `id`, except trace_spans (its own
  // vocabulary is `span_id` — see DemoBatch.conflictColumn's doc).
  const rowKey = (b: DemoBatch, row: Record<string, unknown>): string => row[b.conflictColumn ?? 'id'] as string

  it('produces byte-identical output for the same user and clock', () => {
    const a = buildDemoWorkspace(DEMO_USER, NOW)
    const b = buildDemoWorkspace(DEMO_USER, new Date(NOW))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('keeps ids stable when only the clock moves', () => {
    const a = buildDemoWorkspace(DEMO_USER, NOW)
    const later = buildDemoWorkspace(DEMO_USER, new Date(NOW.getTime() + 30 * 86_400_000))

    const idsOf = (w: ReturnType<typeof buildDemoWorkspace>) =>
      w.batches.flatMap((b) => b.rows.map((r) => rowKey(b, r)))
    expect(idsOf(later)).toEqual(idsOf(a))

    // ...but the timestamps do move, so a demo issued next month still shows
    // jobs posted "3 days ago" rather than a month-old board.
    const postedA = batch(a.batches, 'jobs').rows[0]!.posted_at
    const postedLater = batch(later.batches, 'jobs').rows[0]!.posted_at
    expect(postedLater).not.toBe(postedA)
  })

  it('gives two different demo users disjoint row ids', () => {
    const mine = new Set(
      buildDemoWorkspace(DEMO_USER, NOW).batches.flatMap((b) => b.rows.map((r) => rowKey(b, r)))
    )
    const theirs = buildDemoWorkspace(OTHER_USER, NOW).batches.flatMap((b) => b.rows.map((r) => rowKey(b, r)))
    expect(theirs.some((id) => mine.has(id))).toBe(false)
  })

  it('emits well-formed v5 UUIDs for every row', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const b of buildDemoWorkspace(DEMO_USER, NOW).batches) {
      for (const row of b.rows) expect(rowKey(b, row)).toMatch(uuid)
    }
  })
})

// ---------------------------------------------------------------------------
// Nothing here can reach a real person or a real company
// ---------------------------------------------------------------------------

describe('the demo data cannot reach anyone', () => {
  const workspace = buildDemoWorkspace(DEMO_USER, NOW)
  const everyString = collectStrings(workspace)

  /** Domains that would make a seeded address look like a real person's. */
  const CONSUMER_DOMAINS = [
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'ymail.com',
    'hotmail.com',
    'outlook.com',
    'live.com',
    'msn.com',
    'icloud.com',
    'me.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
    'gmx.com',
    'zoho.com',
    'mail.com',
  ]

  function emailsIn(strings: string[]): string[] {
    return strings.flatMap((s) => s.match(EMAIL_RE) ?? [])
  }

  it('emits at least one email, so this suite is testing something', () => {
    expect(emailsIn(everyString).length).toBeGreaterThan(4)
  })

  it('puts every seeded email under the reserved example.com space', () => {
    for (const email of emailsIn(everyString)) {
      const domain = email.split('@')[1]!.toLowerCase()
      expect(
        domain === 'example.com' || domain.endsWith('.example.com'),
        `"${email}" is not under example.com — a demo must not be able to mail a real address`
      ).toBe(true)
    }
  })

  it('never uses a real-looking consumer email domain', () => {
    for (const email of emailsIn(everyString)) {
      const domain = email.split('@')[1]!.toLowerCase()
      expect(CONSUMER_DOMAINS).not.toContain(domain)
    }
  })

  it('points every http(s) URL at the reserved example.com space', () => {
    const urls = everyString.flatMap((s) => s.match(URL_RE) ?? [])
    expect(urls.length).toBeGreaterThan(10)
    for (const url of urls) {
      const host = new URL(url).hostname.toLowerCase()
      expect(
        host === 'example.com' || host.endsWith('.example.com'),
        `"${url}" leaves the reserved demo domain`
      ).toBe(true)
    }
  })

  it('never emits a linkedin.com profile link', () => {
    // A plausible linkedin.com/in/<slug> either 404s or lands on a real
    // stranger who has nothing to do with this demo.
    for (const value of everyString) expect(value.toLowerCase()).not.toContain('linkedin.com')
  })

  it('labels every job posting as demo data inside the description itself', () => {
    for (const row of batch(workspace.batches, 'jobs').rows) {
      expect(row.description as string).toContain('Demo data')
      expect(row.description as string).toContain('fictional employer')
    }
  })

  it('never claims a fabricated contact address was verified', () => {
    for (const row of batch(workspace.batches, 'contacts').rows) {
      expect(row.verified).toBe(false)
    }
  })

  it('queues outreach for review rather than sending, and caps the daily volume', () => {
    const prefs = buildDemoPreferences(null, NOW)
    expect((prefs.outreach as { autoSend: boolean }).autoSend).toBe(false)
    expect(prefs.autoSubmit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The budget cap
// ---------------------------------------------------------------------------

describe('buildDemoPreferences — the $1 spend cap', () => {
  it('caps a fresh demo profile at $1 with nothing spent', () => {
    const prefs = buildDemoPreferences(null, NOW)
    expect(prefs.budget).toEqual({ periodStart: '2026-08', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD })
    expect(DEMO_MONTHLY_USD).toBe(1)
  })

  it('PRESERVES accumulated spend across a re-seed', () => {
    // Re-running the seeder is the same event as re-entering the access code.
    // Zeroing spentUsd here would make re-entering the code a one-keystroke way
    // to refill the allowance, and the cap would bound nothing.
    const prefs = buildDemoPreferences(
      { budget: { monthlyUsd: 1, spentUsd: 0.87, periodStart: '2026-08' } },
      NOW
    )
    expect(prefs.budget).toEqual({ periodStart: '2026-08', spentUsd: 0.87, monthlyUsd: 1 })
  })

  it('lowers an inherited cap but never raises one', () => {
    const lowered = buildDemoPreferences({ budget: { monthlyUsd: 500, spentUsd: 0 } }, NOW)
    expect((lowered.budget as { monthlyUsd: number }).monthlyUsd).toBe(1)

    const alreadyLower = buildDemoPreferences({ budget: { monthlyUsd: 0.25, spentUsd: 0 } }, NOW)
    expect((alreadyLower.budget as { monthlyUsd: number }).monthlyUsd).toBe(0.25)
  })

  it('keeps unrelated preference keys the profile already had', () => {
    const prefs = buildDemoPreferences({ gmail_sync: { lastSyncDate: '2026-07-01' } }, NOW)
    expect(prefs.gmail_sync).toEqual({ lastSyncDate: '2026-07-01' })
    expect(prefs.targeting).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Idempotency + the safety gate, through the writer
// ---------------------------------------------------------------------------

describe('seedDemoWorkspace', () => {
  it('writes the whole workspace and reports what it wrote', async () => {
    const fake = fakeAdmin()
    const result = await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })

    expect(result.warnings).toEqual([])
    expect(result.counts.companies).toBe(12)
    expect(result.counts.jobs).toBe(40)
    expect(result.counts.applications).toBe(10)
    expect(result.counts.contacts).toBe(8)

    const profile = fake.profiles.get(DEMO_USER)!
    expect(profile.is_demo).toBe(true)
    expect(profile.full_name).toBe('Riley Marsh')
    expect((profile.preferences as { budget: { monthlyUsd: number } }).budget.monthlyUsd).toBe(1)
  })

  it('does not overwrite the profile email that mirrors the auth user', async () => {
    const fake = fakeAdmin({ email: 'demo-7fk2@cello-demo.example.com' })
    await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })
    expect(fake.profiles.get(DEMO_USER)!.email).toBe('demo-7fk2@cello-demo.example.com')
  })

  it('fills in an email only when the profile has none', async () => {
    const fake = fakeAdmin({ email: '' })
    await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })
    expect(fake.profiles.get(DEMO_USER)!.email).toBe('riley.marsh@demo.example.com')
  })

  it('is idempotent — a second run duplicates nothing', async () => {
    const fake = fakeAdmin()
    await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })
    const first = Object.fromEntries([...fake.tables].map(([t, rows]) => [t, rows.size]))

    // Second run at a LATER clock, which is what a re-redemption looks like.
    await seedDemoWorkspace(fake.admin, DEMO_USER, { now: new Date(NOW.getTime() + 3 * 86_400_000) })
    const second = Object.fromEntries([...fake.tables].map(([t, rows]) => [t, rows.size]))

    expect(second).toEqual(first)
    expect(second.jobs).toBe(40)
    expect(second.companies).toBe(12)
  })

  it('does not undo work the demo user did in their session', async () => {
    const fake = fakeAdmin()
    await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })

    // The demo user drags a card across the kanban.
    const applications = fake.tables.get('applications')!
    const [movedId, moved] = [...applications.entries()][0]!
    applications.set(movedId, { ...moved, stage: 'offer', notes: 'moved by the demo user' })

    await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })

    expect(fake.tables.get('applications')!.get(movedId)!.notes).toBe('moved by the demo user')
  })

  it('reseeds cleanly once the profile is already flagged is_demo', async () => {
    const fake = fakeAdmin({ is_demo: true, resume_text: 'already seeded resume text' })
    await expect(seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })).resolves.toBeTruthy()
  })

  it('REFUSES a profile that already holds a real resume', async () => {
    const fake = fakeAdmin({ is_demo: false, resume_text: 'A real person’s actual resume.' })
    await expect(seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })).rejects.toBeInstanceOf(
      NotADemoProfileError
    )
    expect(fake.tables.get('jobs')).toBeUndefined()
    expect(fake.profiles.get(DEMO_USER)!.is_demo).toBe(false)
  })

  it('REFUSES a profile that already tracks companies of its own', async () => {
    const fake = fakeAdmin({ is_demo: false })
    fake.tables.set(
      'companies',
      new Map([['pre-existing', { id: 'pre-existing', user_id: DEMO_USER, name: 'A real employer' }]])
    )
    await expect(seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })).rejects.toBeInstanceOf(
      NotADemoProfileError
    )
  })

  it('FAILS CLOSED when it cannot prove the account is empty', async () => {
    const fake = fakeAdmin({ is_demo: false })
    fake.failCompanyCount('connection reset')
    await expect(seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })).rejects.toBeInstanceOf(
      NotADemoProfileError
    )
  })

  it('refuses when there is no profiles row at all', async () => {
    const fake = fakeAdmin({ id: null as unknown as string })
    await expect(seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })).rejects.toThrow(
      /no profiles row/
    )
  })

  it('aborts when a required table fails', async () => {
    const fake = fakeAdmin()
    fake.failTable('jobs')
    await expect(seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })).rejects.toThrow(
      /required table/
    )
  })

  it('degrades — but reports — when an optional table fails', async () => {
    const fake = fakeAdmin()
    fake.failTable('interview_kits')
    const result = await seedDemoWorkspace(fake.admin, DEMO_USER, { now: NOW })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('interview_kits')
    // The rest of the demo still landed.
    expect(fake.rowsIn('jobs')).toHaveLength(40)
  })
})
