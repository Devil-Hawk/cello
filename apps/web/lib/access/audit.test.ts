// Tests for the access-code audit trail.
//
// The thing under test is a PRIVACY POLICY expressed as code, so most of these
// assert what must NOT come out the other side. ZERO network, ZERO real DB: the
// Supabase client is an in-memory fake built per test, in the same style as
// lib/harness/spend.test.ts.
//
// NOTE ON PLACEMENT: two blocks at the bottom cover code that lives elsewhere —
// resolveDemoContext/recordDemoEvent (lib/access/session.ts), and the four
// feature routes that now feed the trail. Neither session.test.ts nor a
// route.test.ts was one of this change's owned paths, and shipping a
// security-relevant lookup — or an audit trail whose only proof of existence is
// that it typechecks — with no coverage at all was the worse of the two options.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import {
  buildAccessEventRow,
  clientHint,
  clientHintFromHeaders,
  coerceClientHint,
  recordAccessEvent,
  redactAccessCodes,
  sanitizeAction,
  sanitizeDetail,
  sanitizeTarget,
} from './audit'
import { isRecordableToken } from './scrub'
import { generateAccessCode, looksLikeAccessCode, normalizeAccessCode } from './codes'
import { recordDemoEvent, resolveDemoContext } from './session'

/**
 * The service-role client — the only one allowed to answer "is this a demo",
 * and the only one that can write the trail.
 *
 * IT IS INSTALLED HERE, AT THE MODULE BOUNDARY, AND NOWHERE ELSE. session.ts no
 * longer takes an admin client as an argument (see its header: an injectable
 * one is an invitation to pass the caller's own cookie-scoped client, which
 * hands the subject of the audit both the determination and the write, and both
 * failures are silent). Mocking the module is a seam a test has and a route
 * does not.
 *
 * A test that leaves `current` null is asserting what happens on a deployment
 * with no service key configured — never a real client quietly attempting a
 * network call.
 */
const serviceRole = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => {
    if (!serviceRole.current) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
    return serviceRole.current
  },
}))

const CODE_ID = '11111111-2222-4333-8444-555555555555'

/** Secrets and PII deliberately thrown at every entry point. Nothing in this
 *  object may ever appear in a built row. */
const SECRETS = {
  accessCode: 'P7QK-3M9X-TCR2',
  email: 'ankit@walker.health',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  providerKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwx',
  ipv4: '203.0.113.7',
  ipv6: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  resumeLine: 'Senior engineer with 10 years leading platform teams',
  encryptedBlob: 'YWJjZGVmZ2hpams=:bG1ub3BxcnN0dXY=:d3h5ejEyMzQ1Ng==',
}

/**
 * One fake that serves every shape these modules use: the `insert` on
 * access_code_events, and the select chain on access_codes / profiles. Not a
 * general Supabase mock — just this feature's surface.
 *
 * `profileRow` matters as much as `codeRow` now: the profile is read with the
 * SERVICE-ROLE client, so this fake is the only thing that can say a session is
 * a demo.
 */
function fakeAdmin(
  options: {
    codeRow?: unknown
    profileRow?: unknown
    profileError?: { message: string } | null
    insertError?: { message: string } | null
    throwOnInsert?: boolean
    /** Answer for a head-count query — the routes below run those. */
    count?: number
  } = {}
): { admin: SupabaseClient; inserts: { table: string; row: Record<string, unknown> }[] } {
  const inserts: { table: string; row: Record<string, unknown> }[] = []
  const client = {
    from(table: string) {
      const row = async () => {
        if (table === 'access_codes') return { data: options.codeRow ?? null, error: null }
        if (table === 'profiles') {
          return { data: options.profileRow ?? null, error: options.profileError ?? null }
        }
        return { data: null, error: null }
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: row,
        // The routes read the profile with .single(); session.ts uses
        // .maybeSingle(). Same row either way — which is the point: one fake
        // profile is both "is this a demo" and "what is in this workspace".
        single: row,
        // A head-count query is awaited directly, with no terminal call.
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: options.count ?? 0 }).then(resolve, reject),
        // update() -> .eq(...) resolves through the SAME `builder.then` above
        // (runUnitOnce never chains .select() after an update) — see
        // lib/graph/oneshot.ts.
        update: () => builder,
        // Two calling conventions both have to work: a bare
        // `await ...insert(row)` (every pre-port caller) and
        // `await ...insert(row).select('id').single()` (lib/graph/oneshot.ts's
        // agent_runs bootstrap, needed once match/batch + outreach/draft route
        // through runAgentUnit). insert() therefore returns a thenable that is
        // ALSO chainable, rather than resolving immediately.
        insert: (inserted: Record<string, unknown>) => {
          // throwOnInsert/insertError model the AUDIT write failing (this
          // suite's whole point: "auditing never breaks the thing it
          // audits") — scoped to access_code_events specifically, not every
          // table, now that lib/graph/oneshot.ts's agent_runs bootstrap is a
          // SECOND, load-bearing admin insert these routes depend on to run
          // at all. Applying throwOnInsert to that one too would be testing
          // a different claim ("the route survives its OWN journaling infra
          // failing"), which is not what this describe block is about.
          const failing = table === 'access_code_events'
          const settle = async () => {
            if (failing && options.throwOnInsert) throw new Error('connection reset by peer')
            inserts.push({ table, row: inserted })
            return { data: null, error: failing ? (options.insertError ?? null) : null }
          }
          const settleSelected = async () => {
            if (failing && options.throwOnInsert) throw new Error('connection reset by peer')
            inserts.push({ table, row: inserted })
            return { data: { id: `${table}-fake-id`, ...inserted }, error: failing ? (options.insertError ?? null) : null }
          }
          return {
            select: () => ({ single: settleSelected, maybeSingle: settleSelected }),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              settle().then(resolve, reject),
          }
        },
      }
      return builder
    },
  }
  return { admin: client as unknown as SupabaseClient, inserts }
}

/** The same fake, installed as the service-role client session.ts will build. */
function useServiceRole(options: Parameters<typeof fakeAdmin>[0] = {}) {
  const built = fakeAdmin(options)
  serviceRole.current = built.admin
  return built
}

/**
 * The caller's own cookie-scoped client.
 *
 * `claims` is what this client WOULD say about the profile if anyone asked it —
 * and `profileReads()` is how the tests below prove nobody does. The subject of
 * an audit trail does not get a vote on whether it happens.
 */
function fakeSessionClient(options: {
  userId?: string | null
  claims?: Record<string, unknown> | null
}): { supabase: SupabaseClient; profileReads: () => number } {
  let profileReads = 0
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: options.userId ? { id: options.userId } : null },
        error: null,
      }),
    },
    from() {
      profileReads++
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: options.claims ?? null, error: null }),
      }
      return builder
    },
  }
  return { supabase: client as unknown as SupabaseClient, profileReads: () => profileReads }
}

/** A live demo profile, as the service-role client would read it. */
const LIVE_DEMO_PROFILE = { is_demo: true, demo_expires_at: '2999-01-01T00:00:00Z' }
const LIVE_CODE_ROW = { id: CODE_ID, expires_at: '2999-01-01T00:00:00Z', revoked_at: null }

let errorSpy: MockInstance<Parameters<typeof console.error>, ReturnType<typeof console.error>>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  // No service key until a test installs one, so nothing leaks between tests.
  serviceRole.current = null
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('sanitizeAction', () => {
  it('keeps the app vocabulary untouched', () => {
    for (const action of ['page.view', 'jobs.score_batch', 'resume.tailor', 'copilot.run']) {
      expect(sanitizeAction(action)).toBe(action)
    }
  })

  it('normalizes case and out-of-charset characters', () => {
    expect(sanitizeAction('Jobs Score Batch')).toBe('jobs_score_batch')
    expect(sanitizeAction('  outreach:draft!!  ')).toBe('outreach_draft')
  })

  it('truncates to 64 characters and never ends on a separator', () => {
    const long = `jobs.${'lookup_'.repeat(40)}`
    const out = sanitizeAction(long)
    expect(out.length).toBeLessThanOrEqual(64)
    expect(out).not.toMatch(/[._-]$/)

    // A cut landing exactly on a separator must not leave it dangling.
    // ('lo' repeated, not 'a' repeated: 'l' and 'o' are outside the code
    // alphabet, so this exercises truncation without also tripping the
    // access-code scan — which eats long alphabet-only runs on purpose.)
    const head = `${'lo'.repeat(31)}l`
    expect(sanitizeAction(`${head}_tail`)).toBe(head)
  })

  it('strips control characters, so an action cannot forge a second log line', () => {
    expect(sanitizeAction('jobs.score\n[access:audit] fake')).not.toContain('\n')
  })

  it('never lets an access code through as an action', () => {
    expect(sanitizeAction(SECRETS.accessCode)).not.toContain('p7qk')
    expect(sanitizeAction(SECRETS.accessCode)).toContain('redacted')
  })

  it('falls back to a recordable label rather than dropping the event', () => {
    // access_code_events.action is NOT NULL; a nameless event still beats none.
    expect(sanitizeAction('')).toBe('unknown')
    expect(sanitizeAction('!!!')).toBe('unknown')
    expect(sanitizeAction(undefined)).toBe('unknown')
    expect(sanitizeAction({ nope: true })).toBe('unknown')
  })
})

describe('sanitizeTarget', () => {
  it('keeps a plain route', () => {
    expect(sanitizeTarget('/jobs/8f2b')).toBe('/jobs/8f2b')
  })

  it('discards the query string and fragment, where the interesting leaks ride', () => {
    expect(sanitizeTarget('/jobs?q=ankit@walker.health&token=abc')).toBe('/jobs')
    expect(sanitizeTarget('/resume#Senior%20engineer')).toBe('/resume')
  })

  it('truncates to 200 characters', () => {
    const out = sanitizeTarget(`/jobs/${'x'.repeat(500)}`)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(200)
  })

  // FINDING 5, on the other field that used to scrub before it bounded.
  it('bounds a hostile target BEFORE splitting and scrubbing it', () => {
    const started = Date.now()
    const out = sanitizeTarget(`/jobs/${'x'.repeat(20_000_000)}?q=${'y'.repeat(1_000_000)}`)
    const elapsed = Date.now() - started
    expect(out!.length).toBeLessThanOrEqual(200)
    expect(elapsed).toBeLessThan(1000)
  })

  it('redacts secrets embedded in the path itself', () => {
    expect(sanitizeTarget(`/demo/${SECRETS.accessCode}`)).toBe('/demo/[redacted-code]')
    expect(sanitizeTarget(`/contacts/${SECRETS.email}`)).toBe('/contacts/[redacted-email]')
  })

  it('is null when there is nothing to record', () => {
    expect(sanitizeTarget(null)).toBeNull()
    expect(sanitizeTarget('')).toBeNull()
    expect(sanitizeTarget(42)).toBeNull()
  })
})

describe('sanitizeDetail', () => {
  it('keeps counts, ids and enums — what the owner actually needs', () => {
    expect(sanitizeDetail({ count: 25, jobId: 'a1b2', model: 'claude-haiku-4.5', ok: true })).toEqual({
      count: 25,
      jobId: 'a1b2',
      model: 'claude-haiku-4.5',
      ok: true,
    })
  })

  it('drops prose, because prose is where content hides', () => {
    const out = sanitizeDetail({ label: SECRETS.resumeLine, count: 3 })
    expect(out.label).toBeUndefined()
    expect(out.count).toBe(3)
    expect(out._dropped).toBe(1)
  })

  it('drops nested objects and arrays rather than flattening them', () => {
    const out = sanitizeDetail({ nested: { resume: 'text' }, list: [1, 2, 3], count: 1 })
    expect(out).toEqual({ count: 1, _dropped: 2 })
  })

  it('drops keys whose NAME implies content or a secret', () => {
    const out = sanitizeDetail({
      email: 'x',
      token: 'x',
      resume: 'x',
      body: 'x',
      text: 'x',
      prompt: 'x',
      client_ip: 'x',
      codeHash: 'x',
      count: 7,
    })
    expect(out).toEqual({ count: 7, _dropped: 8 })
  })

  it('drops values that are not finite numbers', () => {
    const out = sanitizeDetail({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 1 })
    expect(out).toEqual({ c: 1, _dropped: 2 })
  })

  it('caps the number of keys and says how many it dropped', () => {
    const input: Record<string, number> = {}
    for (let i = 0; i < 40; i++) input[`k${i}`] = i
    const out = sanitizeDetail(input)
    // 12 kept + the _dropped marker.
    expect(Object.keys(out)).toHaveLength(13)
    expect(out._dropped).toBe(28)
  })

  it('bounds the serialized size, whatever the caller does', () => {
    // Values are as long as a value may still BE and stay recordable — 20
    // alphanumerics, the shape rule's whole-value ceiling, spread across
    // single-character segments — so this test exercises the byte backstop
    // rather than being satisfied by the shape rule. (It used to use 60-char
    // values; nothing that long is recordable any more, which is the point of
    // the tightened rule, so the fixture moved to the new ceiling.)
    const input: Record<string, string> = {}
    for (let i = 0; i < 40; i++) input[`${'k'.repeat(38)}${i}`] = 'a-'.repeat(19) + 'a'
    const out = sanitizeDetail(input)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(1024)
    expect(Object.keys(out).length).toBeLessThan(13)
    expect(out._dropped).toBeGreaterThan(0)
  })

  // "NEVER RECORD SECRETS OR PERSONAL DATA" used to be enforced by a no-prose
  // rule that only rejected WHITESPACE — so every single-token secret and every
  // one-word piece of PII walked straight through it.
  it('drops single-token secrets and PII that no pattern would recognise', () => {
    const out = sanitizeDetail({
      ref: '4155550134', // a phone number
      serial: '415-555-0134', // the same, spelled out
      born: '1989-04-17', // a date of birth
      who: 'ankit@walker.health', // an email under an innocuous key
      where: 'https://cello.app/jobs/senior-engineer', // a URL
      opaque: 'ZmFrZXNlY3JldHZhbHVlMTIzNDU2', // a 28-character bearer-ish token
      card: '4111-1111-1111-1111', // a card number
      stage: 'applied', // ...and the kind of value this column is FOR
      count: 3,
    })
    expect(out).toEqual({ stage: 'applied', count: 3, _dropped: 7 })
  })

  it('records the shapes an owner actually needs to read a session', () => {
    const out = sanitizeDetail({
      stage: 'applied',
      model: 'claude-haiku-4.5',
      jobId: 'a1b2',
      at: '2026-08-03T11:22:33Z',
      score: 87,
      tailored: true,
      note: null,
    })
    expect(out).toEqual({
      stage: 'applied',
      model: 'claude-haiku-4.5',
      jobId: 'a1b2',
      at: '2026-08-03T11:22:33Z',
      score: 87,
      tailored: true,
      // 'note' is a content key name — dropped by name, before its value is
      // even looked at.
      _dropped: 1,
    })
  })

  // The same holes, through the front door this time: what a call site writing
  // free-form detail would actually produce.
  it('drops PII and secrets that a letter used to smuggle past the digit rule', () => {
    const out = sanitizeDetail({
      ref: 'tel:4155550134',
      who: 'ssn-123-45-6789',
      born: 'DOB19890417',
      where: 'zip-98101',
      // Innocuous key names on purpose: the deny-list must not be the thing
      // doing the work here, the shape rule must.
      marker: 'gk0hj-cmtpx-n0vrq-sdzwy-bfe0h-knptr',
      blob: 'gk0hjcmt.pxn0vrqs.dzwybfe0',
      count: 2,
    })
    expect(out).toEqual({ count: 2, _dropped: 6 })
  })

  it('drops a value that had to be redacted rather than storing the marker', () => {
    // A redaction is not a fact worth a column: '[redacted-email]' tells the
    // owner nothing they can act on, and `_dropped` already tells them the
    // caller tried to say more than the rules allow.
    const out = sanitizeDetail({ label: SECRETS.email, count: 1 })
    expect(out).toEqual({ count: 1, _dropped: 1 })
  })

  it('drops an id that is spelled entirely in the code alphabet, and counts it', () => {
    // The stated cost of the access-code scan, asserted so nobody rediscovers
    // it later as a mystery: an id made only of code-alphabet characters is
    // indistinguishable from a working code, and the code wins.
    const out = sanitizeDetail({ jobId: '5555-5555-5555', count: 1 })
    expect(out).toEqual({ count: 1, _dropped: 1 })
  })

  // FINDING 5: sanitizeValue used to deepScrub the whole value and only then
  // ask whether it was too long, and sanitizeTarget scrubbed before slicing —
  // so a caller could spend a CPU-second of ours per audit event.
  it('bounds a hostile value BEFORE scrubbing it, not after', () => {
    const huge = 'a'.repeat(20_000_000)
    const started = Date.now()
    const out = sanitizeDetail({ marker: huge, nested: { a: huge }, count: 1 })
    const elapsed = Date.now() - started
    expect(out).toEqual({ count: 1, _dropped: 2 })
    // Scrubbing 20MB with the full pattern set takes seconds; slicing it first
    // takes microseconds. The ceiling is deliberately loose — it is here to
    // catch an order-of-magnitude regression, not to measure the machine.
    expect(elapsed).toBeLessThan(1000)
  })

  it('returns an empty object for anything that is not a plain object', () => {
    expect(sanitizeDetail(null)).toEqual({})
    expect(sanitizeDetail(undefined)).toEqual({})
    expect(sanitizeDetail([1, 2])).toEqual({})
    expect(sanitizeDetail('resume text')).toEqual({})
  })
})

// The shape gate on its own. sanitizeDetail exercises it end to end above, but
// these assert the RULES rather than the pipeline, so a hole cannot hide behind
// an earlier layer redacting the fixture for an unrelated reason.
describe('isRecordableToken', () => {
  // THE HOLE THIS CHANGE CLOSES, PART ONE. The digit rule used to apply only to
  // values that were digits END TO END, so a single letter anywhere switched it
  // off completely. It was latent while nothing wrote free-form detail; the
  // instrumentation added in this change is what makes it a phone number in the
  // owner's export.
  it('rejects a digit run wherever it sits, not only in an all-digits value', () => {
    for (const value of [
      'tel:4155550134',
      'ssn-123456789',
      'user-4155550134',
      'DOB19890417',
      'zip-98101', // a 5-digit ZIP: MAX_BARE_DIGITS used to be 6
      '890417', // a 6-digit date of birth, same reason
    ]) {
      expect(isRecordableToken(value), `${value} should not be recordable`).toBe(false)
    }
  })

  // A run cap alone cannot see a number spelled with separators; a total cap
  // alone cannot see one written straight through. Both are needed.
  it('rejects a number split up with separators', () => {
    for (const value of ['415-555-0134', '4111-1111-1111-1111', 'ssn-123-45-6789', '1989-04-17']) {
      expect(isRecordableToken(value), `${value} should not be recordable`).toBe(false)
    }
  })

  // THE HOLE THIS CHANGE CLOSES, PART TWO. The opaque-token rule only ever
  // looked inside one separator-delimited segment, so splitting a secret with
  // dashes or dots laundered it — and it ignored letters-only runs entirely.
  it('rejects an opaque token however it is punctuated', () => {
    for (const value of [
      'gk0hj-cmtpx-n0vrq-sdzwy-bfe0h-knptr', // 35 chars, dashed every 5
      'gk0hjcmt.pxn0vrqs.dzwybfe0', // 26 chars, dotted every 8
      'gkhjcmtpxnvolrqsdzwybfelhknptrmx', // 32 chars, letters only
      'ZmFrZXNlY3JldHZhbHVlMTIzNDU2', // base64-ish, one run
    ]) {
      expect(isRecordableToken(value), `${value} should not be recordable`).toBe(false)
    }
  })

  it('records the shapes the owner is actually here for', () => {
    for (const value of [
      'applied',
      'pending_review',
      'greenhouse',
      'claude-haiku-4.5',
      'a1b2',
      'v2.3.1',
      '2026', // a year is four digits, and four is the run cap
      '9f8e7d6c-1234-4abc-8def-0123456789ab',
      '2026-08-03T11:22:33Z',
      '2026-08-03T11:22:33.123456Z',
    ]) {
      expect(isRecordableToken(value), `${value} should be recordable`).toBe(true)
    }
  })

  // WHY THE UUID EXCEPTION IS AN EXCEPTION: roughly one uuid in 200 carries a
  // group of twelve straight digits, which every digit rule above would refuse.
  // A uuid is how the owner ties a row to a job, so it is allow-listed by its
  // exact shape rather than by loosening the rule everything else lives under.
  it('records a uuid whose groups are all digits, which no other rule would allow', () => {
    expect(isRecordableToken('9f8e7d61-1234-4abc-8def-012345678901')).toBe(true)
  })

  // The timestamp exception REQUIRES a time of day. A bare date is a date of
  // birth as far as anything downstream can tell.
  it('does not let a bare date in through the timestamp exception', () => {
    expect(isRecordableToken('1989-04-17')).toBe(false)
    expect(isRecordableToken('2026-08-03')).toBe(false)
  })
})

describe('redactAccessCodes', () => {
  it('removes anything that parses as a code, in any spelling', () => {
    for (const spelling of ['P7QK-3M9X-TCR2', 'p7qk3m9xtcr2', 'P7QK 3M9X TCR2']) {
      const out = redactAccessCodes(`/demo/${spelling}`)
      expect(out).toBe('/demo/[redacted-code]')
    }
  })

  it('leaves ids that could not be codes alone', () => {
    // 0 and 1 are not in the code alphabet, so a hex id is safe from redaction.
    expect(redactAccessCodes('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6')
  })

  // FINDING 2: the redaction pattern used to allow only [\s_-] between groups
  // while normalizeAccessCode strips a much wider set — so 'P7QK–3M9X–TCR2'
  // (en dashes, courtesy of autocorrect) still REDEEMED but no longer redacted.
  // This asserts the two cannot drift apart again by deriving the question from
  // the normalizer itself: whatever it strips, the redactor must handle.
  it('handles EVERY separator the normalizer strips, not a hand-copied subset', () => {
    const candidates: string[] = []
    for (const [from, to] of [
      [0x20, 0x7e], // ASCII punctuation and space
      [0xa0, 0xbf], // non-breaking space and friends
      [0x2000, 0x206f], // Unicode spaces, hyphens, dashes, bars
      [0x3000, 0x3002], // ideographic space
    ]) {
      for (let cp = from!; cp <= to!; cp++) candidates.push(String.fromCodePoint(cp))
    }

    const separators = candidates.filter((ch) => normalizeAccessCode(`A${ch}A`) === 'AA')
    // If this is ever 0 the test has stopped testing anything.
    expect(separators.length).toBeGreaterThan(5)

    for (const sep of separators) {
      const spelled = `P7QK${sep}3M9X${sep}TCR2`
      // Precondition: this spelling really does still redeem.
      expect(looksLikeAccessCode(spelled)).toBe(true)
      expect(redactAccessCodes(`/demo/${spelled}`)).toBe('/demo/[redacted-code]')
    }
  })

  it('redacts a freshly generated code, whatever the generator produces', () => {
    const code = generateAccessCode()
    expect(redactAccessCodes(`/demo/${code}`)).toBe('/demo/[redacted-code]')
  })

  // FINDING 3: this returned 'P7QK-[redacted-code]-3M9X-TCR2' — it redacted the
  // ROTATION in the middle, and the two surviving fragments reassemble into a
  // working code the moment a reader deletes the marker.
  it('leaves no fragment that reconstructs a code, even on overlapping codes', () => {
    const doubled = `${SECRETS.accessCode}${SECRETS.accessCode}`
    const out = redactAccessCodes(doubled)
    expect(out).toBe('[redacted-code]')

    for (const fragment of ['P7QK', '3M9X', 'TCR2']) {
      expect(out).not.toContain(fragment)
    }
    // The stronger property, stated as the module states it: nothing that would
    // be REDEEMED survives — including once the markers are deleted, which is
    // the reassembly a human does without thinking about it.
    expect(containsRedeemableCode(out.replaceAll('[redacted-code]', ''))).toBe(false)
  })

  it('leaves nothing redeemable behind, for any arrangement of codes and text', () => {
    const code = SECRETS.accessCode
    const arrangements = [
      code,
      `${code}${code}`,
      `${code}-${code}`,
      `x${code}x`,
      `/demo/${code}?next=/jobs`,
      `${code.slice(0, 5)}${code}`,
      `sent ${code} to a friend`,
      `${code}\n${code}`,
      'P7Q K-3M9 X-TC R2',
    ]
    for (const text of arrangements) {
      expect(containsRedeemableCode(text), `${text} was not redeemable to begin with`).toBe(true)
      const out = redactAccessCodes(text)
      expect(containsRedeemableCode(out), `${text} left something redeemable`).toBe(false)
      expect(
        containsRedeemableCode(out.replaceAll('[redacted-code]', '')),
        `${text} left fragments that reassemble`
      ).toBe(false)
    }
  })
})

/** Would ANY substring of this text be accepted by the redemption endpoint?
 *  Deliberately brute-forced rather than derived, so it cannot share a bug with
 *  the scanner it is checking. */
function containsRedeemableCode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    for (let j = i + 1; j <= text.length; j++) {
      if (looksLikeAccessCode(text.slice(i, j))) return true
    }
  }
  return false
}

describe('clientHint', () => {
  it('is short, opaque hex — never the raw signal', () => {
    const hint = clientHint({ userAgent: 'Mozilla/5.0 (Macintosh)', ip: SECRETS.ipv4 })!
    expect(hint).toMatch(/^[0-9a-f]{12}$/)
    expect(hint).not.toContain('Mozilla')
    expect(SECRETS.ipv4).not.toContain(hint)
  })

  it('is stable, so the owner can tell one visitor from another', () => {
    const a = clientHint({ userAgent: 'UA-1', ip: '203.0.113.7' })
    const b = clientHint({ userAgent: 'UA-1', ip: '203.0.113.7' })
    const c = clientHint({ userAgent: 'UA-2', ip: '203.0.113.7' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('coarsens the address, so one person on a moving connection stays one hint', () => {
    const a = clientHint({ userAgent: 'UA-1', ip: '203.0.113.7' })
    const b = clientHint({ userAgent: 'UA-1', ip: '203.0.113.99' })
    const other = clientHint({ userAgent: 'UA-1', ip: '198.51.100.7' })
    expect(a).toBe(b)
    expect(a).not.toBe(other)
  })

  it('is undefined with no signal, so a NULL column does not read as one visitor', () => {
    expect(clientHint({})).toBeUndefined()
    expect(clientHint({ userAgent: '', ip: null })).toBeUndefined()
  })

  it('derives the same hint from headers', () => {
    const headers = new Headers({
      'user-agent': 'UA-1',
      'x-forwarded-for': '203.0.113.7, 70.41.3.18',
    })
    expect(clientHintFromHeaders(headers)).toBe(clientHint({ userAgent: 'UA-1', ip: '203.0.113.7' }))
  })
})

describe('coerceClientHint', () => {
  it('passes a real hint through unchanged', () => {
    const hint = clientHint({ userAgent: 'UA-1' })!
    expect(coerceClientHint(hint)).toBe(hint)
  })

  it('hashes anything else rather than storing it — a raw IP cannot reach the column', () => {
    const out = coerceClientHint(SECRETS.ipv4)!
    expect(out).toMatch(/^[0-9a-f]{12}$/)
    expect(out).not.toContain('203')
  })

  it('is undefined for nothing', () => {
    expect(coerceClientHint(null)).toBeUndefined()
    expect(coerceClientHint('   ')).toBeUndefined()
    expect(coerceClientHint(12)).toBeUndefined()
  })
})

describe('buildAccessEventRow', () => {
  it('builds the row the migration expects', () => {
    const row = buildAccessEventRow({
      codeId: CODE_ID,
      kind: 'action',
      action: 'jobs.score_batch',
      target: '/jobs',
      detail: { count: 25 },
      clientHint: clientHint({ userAgent: 'UA-1' }),
    })!
    expect(row.code_id).toBe(CODE_ID)
    expect(row.kind).toBe('action')
    expect(row.action).toBe('jobs.score_batch')
    expect(row.target).toBe('/jobs')
    expect(row.detail).toEqual({ count: 25 })
    expect(row.client_hint).toMatch(/^[0-9a-f]{12}$/)
  })

  it('refuses an event that cannot be attributed to a code', () => {
    expect(buildAccessEventRow({ codeId: 'not-a-uuid', kind: 'action', action: 'x' })).toBeNull()
    expect(buildAccessEventRow({ codeId: '', kind: 'action', action: 'x' })).toBeNull()
  })

  it('coerces an unrecognised kind instead of writing it', () => {
    const row = buildAccessEventRow({
      codeId: CODE_ID,
      kind: 'whatever' as 'action',
      action: 'x',
    })!
    expect(row.kind).toBe('action')
  })

  // The single most important test in this file.
  it('lets NOTHING resembling a secret or personal data into the payload', () => {
    const row = buildAccessEventRow({
      codeId: CODE_ID,
      kind: 'action',
      action: `redeem ${SECRETS.accessCode}`,
      target: `/demo/${SECRETS.accessCode}?email=${SECRETS.email}`,
      detail: {
        // Innocuous-looking key names on purpose: the deny list must not be the
        // only thing standing between a secret and the table.
        ref: SECRETS.accessCode,
        label: SECRETS.email,
        marker: SECRETS.jwt,
        slug: SECRETS.providerKey,
        origin: SECRETS.ipv4,
        origin6: SECRETS.ipv6,
        blob: SECRETS.encryptedBlob,
        note: SECRETS.resumeLine,
        header: `Bearer ${SECRETS.jwt}`,
        session: 'sb-access-token=abc123',
        count: 4,
      },
      clientHint: SECRETS.ipv4,
    })!

    const serialized = JSON.stringify(row)
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked into the audit row`).not.toContain(secret)
    }
    // Normalized spellings of the code must not survive either.
    expect(serialized).not.toContain('P7QK3M9XTCR2')
    expect(serialized.toUpperCase()).not.toContain('P7QK')
    // ...and the useful, harmless part is still recorded.
    expect(row.detail.count).toBe(4)
  })
})

describe('recordAccessEvent', () => {
  it('writes the sanitized row to access_code_events', async () => {
    const { admin, inserts } = fakeAdmin()
    await recordAccessEvent(admin, {
      codeId: CODE_ID,
      kind: 'page_view',
      action: 'page.view',
      target: '/jobs?q=secret',
    })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('access_code_events')
    expect(inserts[0].row).toMatchObject({
      code_id: CODE_ID,
      kind: 'page_view',
      action: 'page.view',
      target: '/jobs',
    })
  })

  // Auditing must never take down the feature it is auditing.
  it('swallows a thrown DB error', async () => {
    const { admin } = fakeAdmin({ throwOnInsert: true })
    await expect(
      recordAccessEvent(admin, { codeId: CODE_ID, kind: 'action', action: 'jobs.score_batch' })
    ).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('swallows a returned PostgREST error (RLS refusal looks like this)', async () => {
    const { admin } = fakeAdmin({ insertError: { message: 'new row violates row-level security' } })
    await expect(
      recordAccessEvent(admin, { codeId: CODE_ID, kind: 'action', action: 'resume.tailor' })
    ).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('swallows a client that is not a client at all', async () => {
    await expect(
      recordAccessEvent(null as unknown as SupabaseClient, {
        codeId: CODE_ID,
        kind: 'action',
        action: 'copilot.run',
      })
    ).resolves.toBeUndefined()
  })

  it('does not attempt a write it cannot attribute', async () => {
    const { admin, inserts } = fakeAdmin()
    await recordAccessEvent(admin, { codeId: 'nope', kind: 'action', action: 'copilot.run' })
    expect(inserts).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('never logs the payload it failed to write', async () => {
    const { admin } = fakeAdmin({ throwOnInsert: true })
    await recordAccessEvent(admin, {
      codeId: CODE_ID,
      kind: 'action',
      action: 'resume.tailor',
      target: '/resume',
      detail: { marker: 'unbounded-payload-marker' },
      clientHint: clientHint({ userAgent: 'UA-1' }),
    })
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('[access:audit]')
    expect(logged).toContain('resume.tailor')
    expect(logged).not.toContain('unbounded-payload-marker')
    expect(logged).not.toContain('/resume')
  })

  // FINDING 4: this line wrote input.codeId RAW — no shape check, no cap, no
  // scrub — and it runs precisely when a caller has passed the wrong thing.
  // In this feature, the wrong thing is most often the plaintext code.
  it('never writes a mistaken codeId to stderr, code or not', async () => {
    const { admin, inserts } = fakeAdmin()
    for (const wrong of [
      SECRETS.accessCode,
      normalizeAccessCode(SECRETS.accessCode),
      SECRETS.email,
      SECRETS.jwt,
      `${'x'.repeat(500_000)}`,
    ]) {
      errorSpy.mockClear()
      await recordAccessEvent(admin, { codeId: wrong, kind: 'action', action: 'code.redeem' })
      const logged = String(errorSpy.mock.calls[0]?.[0] ?? '')
      expect(logged).toContain('not-a-uuid')
      expect(logged.length).toBeLessThan(500)
      for (const [name, secret] of Object.entries(SECRETS)) {
        expect(logged, `${name} reached stderr`).not.toContain(secret)
      }
      expect(logged).not.toContain('P7QK')
    }
    // ...and none of those became a row, either.
    expect(inserts).toHaveLength(0)
  })

  it('bounds and scrubs the DB error message it logs', async () => {
    const { admin } = fakeAdmin({
      insertError: { message: `duplicate key value "${SECRETS.accessCode}" ${'x'.repeat(5_000)}` },
    })
    await recordAccessEvent(admin, { codeId: CODE_ID, kind: 'action', action: 'code.redeem' })
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).not.toContain(SECRETS.accessCode)
    expect(logged).not.toContain('P7QK')
    expect(logged.length).toBeLessThan(600)
  })
})

// --- lib/access/session.ts (see the placement note at the top of this file) ---

describe('resolveDemoContext', () => {
  const DEMO_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  it('is null when nobody is signed in', async () => {
    const { supabase } = fakeSessionClient({ userId: null })
    useServiceRole()
    expect(await resolveDemoContext(supabase)).toBeNull()
  })

  // Ordering, not politeness: an anonymous request to an instrumented route
  // must not reach for the service key at all, and must not log.
  it('does not touch the service-role client for an anonymous request', async () => {
    const { supabase } = fakeSessionClient({ userId: null })
    serviceRole.current = null // createAdminClient() would throw if it were called
    expect(await resolveDemoContext(supabase)).toBeNull()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // FINDING 1, and the most important test in this block. profiles.is_demo used
  // to be read with the CALLER'S OWN client, and `false` was taken as "not a
  // demo, nothing to record" — so the subject of the audit trail held the
  // switch for it, and a suppressed trail is indistinguishable from an idle
  // visitor. The determination now comes from the service-role client only.
  it('asks the SERVICE-ROLE client whether this is a demo, never the session itself', async () => {
    const session = fakeSessionClient({
      userId: DEMO_USER,
      // What a demo would like this lookup to believe.
      claims: { is_demo: false, demo_expires_at: null },
    })
    useServiceRole({ profileRow: LIVE_DEMO_PROFILE, codeRow: LIVE_CODE_ROW })

    const context = await resolveDemoContext(session.supabase)

    expect(context?.isDemo).toBe(true)
    expect(context?.codeId).toBe(CODE_ID)
    // Not "the lie was overruled" — the lie was never asked for.
    expect(session.profileReads()).toBe(0)
  })

  it('is null for an ordinary user', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({ profileRow: { is_demo: false, demo_expires_at: null } })
    expect(await resolveDemoContext(supabase)).toBeNull()
  })

  it('is null when neither a profile nor a code points at this user', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({ profileRow: null, codeRow: null })
    expect(await resolveDemoContext(supabase)).toBeNull()
  })

  // "Delete the row that says I am being watched" must not be a way to stop
  // being watched: a missing profile is not proof of anything, so the codes
  // table gets the last word.
  it('still attributes a demo whose profile row has gone missing', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({ profileRow: null, codeRow: LIVE_CODE_ROW })
    const context = await resolveDemoContext(supabase)
    expect(context?.isDemo).toBe(true)
    expect(context?.codeId).toBe(CODE_ID)
    expect(context?.active).toBe(true)
  })

  // The same OR'd reading the guardrails use (isDemoProfile): a row carrying a
  // demo deadline is a demo even if a partial update dropped the flag. A
  // session must not be a demo for the guardrails and an ordinary user for the
  // audit trail.
  it('still treats a profile that kept only its deadline as a demo', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({
      profileRow: { is_demo: false, demo_expires_at: '2999-01-01T00:00:00Z' },
      codeRow: LIVE_CODE_ROW,
    })
    expect((await resolveDemoContext(supabase))?.isDemo).toBe(true)
  })

  it('is null, and says so, when the service-role client cannot be built', async () => {
    // No service key installed, so createAdminClient() throws (see the top of
    // this file). Losing the audit row is the honest outcome — it grants
    // nothing, and guessing "probably not a demo" from a client we could not
    // build would be the fail-open version of finding 1.
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    expect(await resolveDemoContext(supabase)).toBeNull()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves the code a live demo session came from', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({ profileRow: LIVE_DEMO_PROFILE, codeRow: LIVE_CODE_ROW })
    expect(await resolveDemoContext(supabase)).toEqual({
      isDemo: true,
      demoUserId: DEMO_USER,
      codeId: CODE_ID,
      active: true,
      expiresAt: '2999-01-01T00:00:00Z',
    })
  })

  it('reports an expired or revoked demo as inactive but still a demo', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({
      profileRow: LIVE_DEMO_PROFILE,
      codeRow: { id: CODE_ID, expires_at: '2999-01-01T00:00:00Z', revoked_at: '2026-01-01T00:00:00Z' },
    })
    const revokedContext = await resolveDemoContext(supabase)
    expect(revokedContext?.isDemo).toBe(true)
    expect(revokedContext?.active).toBe(false)

    useServiceRole({
      profileRow: LIVE_DEMO_PROFILE,
      codeRow: { id: CODE_ID, expires_at: '2020-01-01T00:00:00Z', revoked_at: null },
    })
    expect((await resolveDemoContext(supabase))?.active).toBe(false)
  })

  it('takes the STRICTER of the profile and code deadlines', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({
      profileRow: { is_demo: true, demo_expires_at: '2020-01-01T00:00:00Z' },
      codeRow: LIVE_CODE_ROW,
    })
    const context = await resolveDemoContext(supabase)
    expect(context?.expiresAt).toBe('2020-01-01T00:00:00Z')
    expect(context?.active).toBe(false)
  })

  it('FAILS CLOSED when a deadline cannot be read', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({
      profileRow: { is_demo: true, demo_expires_at: 'not-a-date' },
      codeRow: LIVE_CODE_ROW,
    })
    expect((await resolveDemoContext(supabase))?.active).toBe(false)
  })

  it('still reports the demo when no code row points at it', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({ profileRow: LIVE_DEMO_PROFILE, codeRow: null })
    const context = await resolveDemoContext(supabase)
    expect(context?.isDemo).toBe(true)
    expect(context?.codeId).toBeNull()
  })

  it('is null (and logged) when the profile cannot be read', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({ profileError: { message: 'connection reset' } })
    expect(await resolveDemoContext(supabase)).toBeNull()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('bounds and scrubs what a lookup failure puts on stderr', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({
      profileError: { message: `row "${SECRETS.accessCode}" ${SECRETS.email} ${'x'.repeat(5_000)}` },
    })
    expect(await resolveDemoContext(supabase)).toBeNull()
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).not.toContain(SECRETS.accessCode)
    expect(logged).not.toContain(SECRETS.email)
    expect(logged).not.toContain('P7QK')
    expect(logged.length).toBeLessThan(600)
  })
})

describe('recordDemoEvent', () => {
  const DEMO_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  it('records against the session’s code', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    const { inserts } = useServiceRole({
      profileRow: LIVE_DEMO_PROFILE,
      codeRow: LIVE_CODE_ROW,
    })
    await recordDemoEvent(supabase, { kind: 'action', action: 'jobs.score_batch' })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].row).toMatchObject({ code_id: CODE_ID, action: 'jobs.score_batch' })
  })

  // The property that lets this be sprinkled through the app: an owner's own
  // traffic is never written to anybody's audit trail.
  it('writes nothing for an ordinary user', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    const { inserts } = useServiceRole({ profileRow: { is_demo: false, demo_expires_at: null } })
    await recordDemoEvent(supabase, { kind: 'action', action: 'jobs.score_batch' })
    expect(inserts).toHaveLength(0)
  })

  // A demo cannot make its own activity invisible by lying to its own client:
  // the event still lands, attributed to the right code.
  it('records a demo that claims not to be one', async () => {
    const { supabase } = fakeSessionClient({
      userId: DEMO_USER,
      claims: { is_demo: false, demo_expires_at: null },
    })
    const { inserts } = useServiceRole({
      profileRow: LIVE_DEMO_PROFILE,
      codeRow: LIVE_CODE_ROW,
    })
    await recordDemoEvent(supabase, { kind: 'action', action: 'outreach.draft' })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].row).toMatchObject({ code_id: CODE_ID, action: 'outreach.draft' })
  })

  // The hint is DERIVED from the headers here, never accepted as a value, so a
  // call site cannot put a raw address or user-agent in the column.
  it('derives the visitor hint from the request headers', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    const { inserts } = useServiceRole({ profileRow: LIVE_DEMO_PROFILE, codeRow: LIVE_CODE_ROW })
    const headers = new Headers({ 'user-agent': 'UA-1', 'x-forwarded-for': SECRETS.ipv4 })

    await recordDemoEvent(supabase, { kind: 'action', action: 'jobs.score_batch', headers })

    const row = inserts[0].row as { client_hint: string | null }
    expect(row.client_hint).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(inserts[0].row)).not.toContain(SECRETS.ipv4)
    expect(JSON.stringify(inserts[0].row)).not.toContain('UA-1')
  })

  it('records no hint at all when the caller passes no headers', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    const { inserts } = useServiceRole({ profileRow: LIVE_DEMO_PROFILE, codeRow: LIVE_CODE_ROW })
    await recordDemoEvent(supabase, { kind: 'action', action: 'jobs.score_batch' })
    expect((inserts[0].row as { client_hint: string | null }).client_hint).toBeNull()
  })

  it('never throws, whatever the session client does', async () => {
    const broken = {
      auth: {
        getUser: async () => {
          throw new Error('cookies unavailable')
        },
      },
    } as unknown as SupabaseClient
    useServiceRole({ profileRow: LIVE_DEMO_PROFILE })
    await expect(
      recordDemoEvent(broken, { kind: 'action', action: 'copilot.run' })
    ).resolves.toBeUndefined()
  })

  it('never throws when the insert itself throws', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    useServiceRole({
      profileRow: LIVE_DEMO_PROFILE,
      codeRow: LIVE_CODE_ROW,
      throwOnInsert: true,
    })
    await expect(
      recordDemoEvent(supabase, { kind: 'action', action: 'jobs.score_batch' })
    ).resolves.toBeUndefined()
  })

  // The whole reason a route may await this: the event is a description of the
  // request, and a description that fails must not take the request with it.
  it('lets NOTHING a route might pass reach the row', async () => {
    const { supabase } = fakeSessionClient({ userId: DEMO_USER })
    const { inserts } = useServiceRole({ profileRow: LIVE_DEMO_PROFILE, codeRow: LIVE_CODE_ROW })

    await recordDemoEvent(supabase, {
      kind: 'action',
      action: 'outreach.draft',
      target: `/contacts?email=${SECRETS.email}`,
      detail: {
        // What a careless call site would pass instead of counts.
        subject: 'Following up on the platform role',
        recipient: SECRETS.email,
        phone: '415-555-0134',
        key: SECRETS.providerKey,
        resumeLine: SECRETS.resumeLine,
        count: 1,
      },
      headers: new Headers({ 'x-real-ip': SECRETS.ipv4 }),
    })

    const serialized = JSON.stringify(inserts[0].row)
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked into the audit row`).not.toContain(secret)
    }
    expect(serialized).not.toContain('555-0134')
    expect(serialized).not.toContain('Following up')
    expect((inserts[0].row as { detail: Record<string, unknown> }).detail.count).toBe(1)
  })
})

// --- the routes that feed the trail (see the placement note at the top) ------
//
// WHY THESE EXIST: recordDemoEvent shipped with zero production call sites, so
// the owner's timeline said "Redeemed a code" and nothing else, forever. Every
// test below asserts the four properties the instrumentation has to hold:
//
//   1. a demo session's real work lands in access_code_events,
//   2. an ordinary user's identical request writes NOTHING, anywhere,
//   3. an audit write that fails does not fail the request it describes, and
//   4. nothing the route was handling — a résumé, an email, a person — reaches
//      the row.
//
// The routes are driven for real; only their I/O neighbours are faked.

const DEMO_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** The caller's cookie-scoped client, as `createClient()` hands it to a route. */
const routeSession = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => routeSession.current }))

// The routes' own I/O, stubbed at the module boundary. None of these modules is
// under test here; what is under test is the audit row each route produces.
vi.mock('@/lib/contacts/keys', () => ({
  readContactProviderKeys: async () => ({ hunter: null, apollo: null }),
}))
vi.mock('@/lib/contacts/sources', () => ({
  sourceContactsForCompany: async () => ({
    companyId: 'company-1',
    companyName: 'Acme',
    domain: 'acme.test',
    jobId: null,
    // Real-looking people, on purpose: property 4 has to hold against them.
    candidates: [{ name: 'Dana Okafor', email: 'dana.okafor@acme.test' }],
    inserted: [{ id: 'contact-1', name: 'Dana Okafor', email: 'dana.okafor@acme.test', source: 'pattern' }],
    skippedExisting: 2,
    providers: [],
    freePathOnly: true,
    provenanceColumnsAvailable: true,
    search: { headline: 'Read 3 pages on acme.test', steps: [] },
  }),
}))
vi.mock('@/lib/outreach/config', () => ({ readOutreachConfig: async () => ({ openrouterKey: undefined }) }))
vi.mock('@/lib/outreach/store', () => ({
  findDuplicateInitial: async () => null,
  insertOutreach: async (_client: unknown, row: Record<string, unknown>) => ({ id: 'msg-1', ...row }),
}))
vi.mock('@/lib/resume/store', () => ({
  createMarkdownVersion: async () => ({ id: 'doc-1', version: 4, title: null }),
  deleteVersion: async () => {},
  getBaseResume: async () => null,
  getVersionById: async () => ({ id: 'doc-1', version: 4, title: null }),
  listVersions: async () => [],
}))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({ openrouter: 'or-key', userId: DEMO_USER }) }))
// runAgentUnit('bulk_matcher')/('outreach') now route match/batch + outreach/draft
// through lib/harness/registry.ts's UNIT_REGISTRY, which imports the REAL
// `matcher` AgentFn (never invoked by either flow under test here, but it must
// exist for the module to resolve) — importOriginal keeps it real while still
// overriding userCompanyIds, same pattern trail-producers.test.ts already uses
// for @/lib/harness/agents/outreach below.
vi.mock('@/lib/harness/agents/matcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/agents/matcher')>()),
  userCompanyIds: async () => ['company-1'],
}))
vi.mock('@/lib/harness/agents/bulk_matcher', () => ({
  runBulkMatch: async () => ({
    scored: 7,
    failed: 1,
    candidatesConsidered: 9,
    skippedReasons: {},
    batches: 2,
    tokensUsed: 1234,
    jobOutcomes: [],
  }),
}))
// generateOutreachDraft is mocked (rather than left real) so the outreach/draft
// case below never reaches a real model call through ctx.llm — loadApiKeys
// above hands back a real-looking key, and without this the test would try an
// actual OpenRouter request. tokensUsed: 0 keeps the `used_llm: false`
// expectation in the cases table below true (see draft/route.ts's
// `usedLlm = draft.tokensUsed > 0`).
vi.mock('@/lib/harness/agents/outreach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/agents/outreach')>()),
  generateOutreachDraft: async () => ({ subject: 'Re: role', body: 'Body', tokensUsed: 0 }),
}))
// verifyOutreachDraft calls the REAL judge (autoevals -> a real fetch) —
// loadApiKeys above hands back a real-looking key, so without this the
// outreach/draft case would attempt an actual OpenRouter request. Faked as a
// pass-through, same reasoning as generateOutreachDraft's own mock above.
vi.mock('@/lib/graph/verify/outreach', () => ({
  verifyOutreachDraft: async ({ draft }: { draft: { subject: string; body: string; tokensUsed: number } }) => ({
    subject: draft.subject,
    body: draft.body,
    tokensUsed: draft.tokensUsed,
    verdicts: [],
    failedVerdict: false,
  }),
}))

import { POST as scoreBatch } from '@/app/api/agents/match/batch/route'
import { POST as sourceContacts } from '@/app/api/contacts/source/route'
import { POST as draftOutreach } from '@/app/api/outreach/draft/route'
import { POST as resumeDocuments } from '@/app/api/resume/documents/route'

/**
 * The cookie-scoped client a route reads its own tables through. Rows are keyed
 * by table; a head-count query resolves to `count`.
 */
function installRouteSession(rows: Record<string, unknown> = {}): void {
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: DEMO_USER, email: 'demo@cello.test' } }, error: null }),
    },
    from(table: string) {
      const row = async () => ({ data: rows[table] ?? null, error: null })
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        maybeSingle: row,
        single: row,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 3 }).then(resolve, reject),
      }
      return builder
    },
  }
  routeSession.current = client
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'UA-1', 'x-real-ip': SECRETS.ipv4 },
    body: JSON.stringify(body),
  })
}

/** The demo workspace as BOTH clients see it: a demo profile that also has the
 *  resume and preferences the feature routes read. */
const DEMO_WORKSPACE_PROFILE = {
  ...LIVE_DEMO_PROFILE,
  resume_text: 'Senior engineer with 10 years leading platform teams',
  preferences: {},
  full_name: 'Demo Visitor',
}

/** The one row an instrumented route should have written. */
function auditRows(inserts: { table: string; row: Record<string, unknown> }[]) {
  return inserts.filter((i) => i.table === 'access_code_events').map((i) => i.row)
}

describe('instrumented routes', () => {
  interface Case {
    name: string
    action: string
    /** Runs the route and returns its response. */
    run: () => Promise<Response>
    /** What the timeline should be able to say. */
    detail: Record<string, unknown>
    target: string
  }

  const cases: Case[] = [
    {
      name: 'POST /api/agents/match/batch',
      action: 'jobs.score_batch',
      target: '/jobs',
      detail: { count: 7, failed: 1, considered: 9, remaining: 0 },
      run: () => scoreBatch(post('/api/agents/match/batch', { limit: 10 })),
    },
    {
      name: 'POST /api/contacts/source',
      action: 'contacts.source',
      target: '/contacts',
      detail: { count: 1, candidates: 1, skipped_existing: 2 },
      run: () => sourceContacts(post('/api/contacts/source', { companyId: 'company-1' })),
    },
    {
      name: 'POST /api/outreach/draft',
      action: 'outreach.draft',
      target: '/contacts',
      detail: { count: 1, stage: 'pending_review', used_llm: false },
      run: () => draftOutreach(post('/api/outreach/draft', { contactId: 'contact-1' })),
    },
    {
      name: 'POST /api/resume/documents (save)',
      action: 'resume.upload',
      target: '/resume',
      detail: { source: 'base', version: 4 },
      run: () =>
        resumeDocuments(
          post('/api/resume/documents', {
            action: 'save',
            jobId: null,
            source: 'base',
            markdown: '# Dana Okafor\n\nSenior engineer, dana.okafor@acme.test',
          })
        ),
    },
  ]

  beforeEach(() => {
    installRouteSession({
      profiles: DEMO_WORKSPACE_PROFILE,
      contacts: {
        id: 'contact-1',
        name: 'Dana Okafor',
        email: 'dana.okafor@acme.test',
        title: 'VP Engineering',
        company_id: null,
      },
    })
  })

  for (const testCase of cases) {
    describe(testCase.name, () => {
      it('records exactly one event for a demo session', async () => {
        const { inserts } = useServiceRole({
          profileRow: DEMO_WORKSPACE_PROFILE,
          codeRow: LIVE_CODE_ROW,
        })

        const response = await testCase.run()

        expect(response.status).toBe(200)
        const rows = auditRows(inserts)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          code_id: CODE_ID,
          kind: 'action',
          action: testCase.action,
          target: testCase.target,
        })
        expect(rows[0].detail).toEqual(testCase.detail)
        // The visitor hint rides along, so the owner can tell two people
        // sharing one code apart — hashed, never the address itself.
        expect(rows[0].client_hint).toMatch(/^[0-9a-f]{12}$/)
      })

      // The property that makes this safe to sprinkle through the app: the
      // owner's own job search is never written to anybody's audit trail.
      it('records NOTHING for an ordinary user', async () => {
        const { inserts } = useServiceRole({
          profileRow: { ...DEMO_WORKSPACE_PROFILE, is_demo: false, demo_expires_at: null },
          codeRow: LIVE_CODE_ROW,
        })

        const response = await testCase.run()

        expect(response.status).toBe(200)
        expect(auditRows(inserts)).toHaveLength(0)
      })

      // Auditing never breaks the thing it audits. The route is awaited on the
      // audit write, so this is the test that says an outage in the trail is
      // not an outage in the product.
      it('still answers the request when the audit write throws', async () => {
        useServiceRole({
          profileRow: DEMO_WORKSPACE_PROFILE,
          codeRow: LIVE_CODE_ROW,
          throwOnInsert: true,
        })

        const response = await testCase.run()

        expect(response.status).toBe(200)
      })

      it('puts nothing about the work itself in the row', async () => {
        const { inserts } = useServiceRole({
          profileRow: DEMO_WORKSPACE_PROFILE,
          codeRow: LIVE_CODE_ROW,
        })

        await testCase.run()

        const serialized = JSON.stringify(auditRows(inserts))
        // The people, the résumé and the address that passed through this
        // request — none of them are the shape of a session.
        for (const leak of [
          'Dana Okafor',
          'dana.okafor@acme.test',
          'Senior engineer',
          'VP Engineering',
          'Demo Visitor',
          SECRETS.ipv4,
          'UA-1',
        ]) {
          expect(serialized, `${leak} leaked into the audit row`).not.toContain(leak)
        }
      })
    })
  }
})
