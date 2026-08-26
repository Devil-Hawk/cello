// Guards the fix in this commit: an .in(column, ids) filter built from
// unbounded user data (most often "every company/job id this user owns")
// re-sends that whole array in the request querystring on every call, which
// is fine at ten ids and fatal at ~600 — the exact production incident this
// commit fixes (jobs page + every server-side equivalent). PostgREST/the
// gateway both cap URL length; there is no per-caller size where this stops
// being a landmine, only a size nobody had reached yet.
//
// HOW IT WORKS
//   A source-level scan finds every `.in('column', <arg>)` call under app/
//   and lib/ (comments stripped, so an explanatory comment quoting `.in(...)`
//   — like the ones this commit left behind — can't feed itself back into the
//   scan). Two argument shapes are self-evidently bounded and need no manual
//   sign-off: an inline array literal (`['a', 'b']`, a fixed enum of values)
//   and anything sliced inline (`.slice(0, N)`, a hard cap right there in the
//   call). Every other call — a bare variable — must appear in ALLOWLIST
//   below with a one-line reason it's actually bounded (a chunked-helper's
//   own per-batch parameter, a query capped upstream, an explicit small
//   caller-provided list). An .in() call that matches neither shape nor the
//   allowlist is a hard failure: the next person has to prove it's bounded
//   (fix it with the FK-join pattern in lib/harness/agents/matcher.ts's
//   ownedJobsQuery, or chunk it with lib/supabase/chunked-in.ts) or add it
//   here with a reason that survives review.
//
// This is the same technique as lib/security/injection-chokepoints.test.ts
// and lib/harness/spend-chokepoints.test.ts: assert the guarantee at the
// source level, across every file, because that's what catches the NEXT call
// site — the one nobody is looking at yet.

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Tests run with cwd = apps/web; the scan spans app/ and lib/ within it. */
const REPO_ROOT = path.resolve(process.cwd(), '../..')
const SCAN_ROOTS = ['apps/web/app', 'apps/web/lib']

/**
 * ALLOWLIST — every `.in('col', <bare-variable>)` call site that is NOT an
 * inline array literal or an inline `.slice(...)`, keyed by the exact call
 * text the scan below produces (repo-relative file -> call texts). Each
 * reason is why that specific variable can never reach an unbounded size.
 */
const ALLOWLIST: Record<string, { calls: string[]; reason: string }> = {
  'apps/web/lib/access/demo-wipe.ts': {
    calls: [".in('user_id', chunk)"],
    reason: "chunked-helper internal — chunk is chunkedIn's own per-batch parameter, capped at 100 by construction.",
  },
  'apps/web/app/(app)/resume/page.tsx': {
    calls: [".in('id', missing)"],
    reason: 'missing is built via .slice(0, TAILOR_LIMIT) immediately above — already capped before this call.',
  },
  'apps/web/app/api/gmail/enrich/route.ts': {
    calls: [".in('id', companyFilter)"],
    reason:
      'RLS-scoped request client (not the admin client), and companyFilter is whatever subset the CALLER put in ' +
      'the request body — never server-derived from the full owned-company set, so it never replays the ~600+ ' +
      'company incident.',
  },
  'apps/web/app/api/harness/cron/route.ts': {
    calls: [".in('thread_id', chunk)"],
    reason: "chunked-helper internal — chunk is chunkedIn's own per-batch parameter, capped at 100 by construction.",
  },
  'apps/web/app/api/jobs/provenance/route.ts': {
    calls: [".in('id', exampleIds)"],
    reason: 'One id per EmployerClass enum value — a fixed, tiny set, not per-user data.',
  },
  'apps/web/app/api/notifications/queue/route.ts': {
    calls: [".in( 'subject_id', rows.map((r)"],
    reason:
      'rows is the SAME already-.limit(limit)-capped (MAX_LIMIT=200) application_drafts read this route just ' +
      'made a few lines above, one draft id per row — never an owned-id set, same shape as ' +
      "lib/evals/verdicts.ts's unjudgedCvTailorDraftIds entry below.",
  },
  'apps/web/lib/evals/verdicts.ts': {
    calls: [".in('subject_id', draftIds)"],
    reason:
      'unjudgedCvTailorDraftIds: the batch-approve GET manifest caps draftIds at .limit(200), and the POST ' +
      're-validation (approveOne) always calls this with a single-element array — never an owned-id set.',
  },
  'apps/web/lib/graph/autopilot.ts': {
    calls: [".in('job_id', jobIds)", ".in('subject_id', jobIds)"],
    reason:
      "jobIds is pendingDraftJobIds(goal) — one autopilot goal's own small kept-list, not an owned-id set; the " +
      "second call (loadFailedVerdictJobIds) filters rows already capped by loadCandidateJobs' own " +
      'CANDIDATE_JOB_LIMIT (150) query above it.',
  },
  'apps/web/lib/graph/distill.ts': {
    calls: [".in('id', ids)"],
    reason:
      "fetchRationales's only caller (distillCandidate) passes candidate.verdictIds.slice(0, " +
      'RATIONALE_SAMPLE_SIZE) — capped at 6 before this call ever runs, regardless of how many verdict ids ' +
      "a candidate's own SQL aggregation carries.",
  },
  'apps/web/lib/harness/agents/enricher.ts': {
    calls: [".in('id', chunk)"],
    reason: "chunked-helper internal — chunk is chunkedIn's own per-batch parameter, capped at 100 by construction.",
  },
  'apps/web/lib/harness/agents/follow_upper.ts': {
    calls: [".in('application_id', appIds)", ".in('stage', ACTIVE_STAGES)"],
    reason:
      'appIds comes from a query already limited to MAX_APPS (50) or a single explicit applicationId; ' +
      'ACTIVE_STAGES is a fixed 3-element const, not user data.',
  },
  'apps/web/lib/harness/agents/matcher.ts': {
    calls: [".in('id', ids)"],
    reason:
      'fetchJobsByIds: every caller caps the id list (score_jobs\' SCORE_JOBS_MAX_LIMIT=15, or selectCandidateJobs\' ' +
      'poolSize) before it reaches here; ownership is enforced separately by ownedJobsQuery\'s FK join.',
  },
  'apps/web/lib/harness/agents/verifier.ts': {
    calls: [".in('id', knockouts)"],
    reason: 'knockouts can never exceed the MAX_JOBS (30) batch it was collected from in the same run.',
  },
  'apps/web/lib/harness/copilot-tools.ts': {
    calls: [".in('id', jobIds)", ".in('id', companyIds)", ".in('id', trgmIds)", ".in('id', contactIds)"],
    reason:
      "loadJobBriefs: jobIds is always ≤20 ids (every caller slices/caps before calling); companyIds is the " +
      'deduped company_id set of those ≤20 job rows. listJobs\' trgmIds and listContacts\' contactIds are both ' +
      "search_*_by_*_trgm()'s p_limit-bounded RPC result (clampLimit'd to ≤15/≤25, hard RPC ceiling 50 — see " +
      '20260816000009_job_search.sql), never an owned-id set.',
  },
  'apps/web/lib/strategy/datasource.ts': {
    calls: [".in('id', chunk)"],
    reason: "chunked-helper internal — chunk is chunkedIn's own per-batch parameter, capped at 100 by construction.",
  },
  'apps/web/lib/context/assemble.ts': {
    calls: [".in('kind', kinds)", ".in('external_id', externalIds)"],
    reason:
      "relevantInsights: kinds filters the insights.kind ENUM COLUMN (callers pass a fixed literal like " +
      "['strategy','pattern']), not a user-owned id set. storedCompanyPages: externalIds is " +
      'STORED_PAGE_KINDS.map(...) — a fixed 3-element const (home/about/careers), never per-user data.',
  },
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(full) && !full.endsWith('.test.ts') && !full.endsWith('.test.tsx') && !full.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function scannedFiles(): string[] {
  const out: string[] = []
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) out.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  }
  return out.sort()
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

/** `.in('column', <arg-up-to-the-first-close-paren>)` — good enough to
 *  classify boundedness without a real parser: an inline array literal or an
 *  inline `.slice(` always shows up before the first `)`, and a bare
 *  variable's own trailing `)` is exactly that first `)`. */
const CALL_RE = /\.in\(\s*(['"][\w.]+['"])\s*,\s*([^)]*)\)/g

const INLINE_ARRAY_RE = /^\s*\[/
const INLINE_SLICE_RE = /\.slice\(/

interface Finding {
  file: string
  callText: string
  arg: string
}

function scanFile(rel: string): Finding[] {
  const flat = stripComments(read(rel)).replace(/\s+/g, ' ')
  const found: Finding[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(CALL_RE)
  while ((m = re.exec(flat))) {
    found.push({ file: rel, callText: m[0], arg: m[2] })
  }
  return found
}

const ALL_FILES = scannedFiles()
const ALL_FINDINGS = ALL_FILES.flatMap(scanFile)

/** Findings whose argument is NOT self-evidently bounded (no inline array
 *  literal, no inline .slice()) — these must be on the ALLOWLIST. */
const NEEDS_ALLOWLIST = ALL_FINDINGS.filter((f) => !INLINE_ARRAY_RE.test(f.arg) && !INLINE_SLICE_RE.test(f.arg))

function isAllowed(f: Finding): boolean {
  return ALLOWLIST[f.file]?.calls.includes(f.callText) ?? false
}

describe('every .in() filter is either bounded inline or on the ownership-scoping allowlist', () => {
  it('finds files to check (guards against a broken walk silently passing)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(200)
  })

  it('finds at least the known .in() call sites (guards against a broken scan silently passing)', () => {
    expect(ALL_FINDINGS.length).toBeGreaterThanOrEqual(15)
  })

  it('every non-inline-bounded .in() call site is on the allowlist', () => {
    const unclassified = NEEDS_ALLOWLIST.filter((f) => !isAllowed(f))
    expect(
      unclassified.map((f) => `${f.file} :: ${f.callText}`),
      'These .in() calls filter on a bare variable that is not an inline array literal or an inline ' +
        '.slice() — each one needs to be either provably bounded (add it to ALLOWLIST in ' +
        'lib/supabase/in-scoping-chokepoints.test.ts with a one-line reason) or fixed: an ownership-fence ' +
        'array (e.g. every company/job id this user owns) should filter through the FK join instead ' +
        '(see lib/harness/agents/matcher.ts\'s ownedJobsQuery), and a genuine explicit id subset that can ' +
        'grow unbounded should go through lib/supabase/chunked-in.ts\'s chunkedIn().'
    ).toEqual([])
  })

  it('every allowlist entry still exists in its file (catches a stale/rotted exemption)', () => {
    const stale: string[] = []
    for (const [file, { calls }] of Object.entries(ALLOWLIST)) {
      if (!existsSync(path.join(REPO_ROOT, file))) {
        stale.push(`${file} (file no longer exists)`)
        continue
      }
      const flat = stripComments(read(file)).replace(/\s+/g, ' ')
      for (const call of calls) {
        if (!flat.includes(call)) stale.push(`${file} :: ${call}`)
      }
    }
    expect(stale, `Allowlist entries whose call text no longer appears in the file:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('the jobs page has no unbounded company-id filter (the incident this commit fixes)', () => {
    const findings = scanFile('apps/web/app/(app)/jobs/page.tsx')
    expect(findings.filter((f) => f.callText.includes("'company_id'"))).toEqual([])
  })
})
