// Guards the invariant lib/entities/companies.ts states about itself: that it
// is THE accessor for company-identity-sensitive reads, not merely a nice
// helper sitting next to ones that keep querying raw.
//
// WHY THIS FILE EXISTS
//   A merge is pure indirection (companies.canonical_id) — nothing rewrites a
//   job/contact/dossier row's company_id. That means a raw `.eq('company_id',
//   someId)` is silently WRONG the moment someId has been merged into a
//   survivor: not an error, just a query that quietly returns the duplicate's
//   now-stale view (or nothing) instead of the real one. Nothing in review
//   catches that — the query is syntactically fine and passes today, because
//   nothing has been merged yet. So this is a source-level scan, the same
//   shape as lib/harness/spend-chokepoints.test.ts and
//   lib/access/demo-chokepoints.test.ts: it catches the NEXT raw read added
//   to these modules, not just the ones the company-identity audit named.
//
// SCOPE: the four places the audit named — lib/harness/agents/matcher.ts,
// lib/contacts/**, lib/dossier/**, and the company-facing app/api aggregates
// (app/api/contacts/**, app/api/companies/**) — not the whole repo. `.eq
// ('company_id', ...)` is an ordinary, entirely legitimate filter throughout
// jobs/contacts CRUD (ownership scoping, inserts, per-row lookups); scanning
// every occurrence repo-wide would either flag dozens of unrelated files or
// force an allowlist so wide it stops meaning anything. These four are where
// the audit found company-LEVEL aggregate reads (a count, a one-per-company
// lookup) actually living.
//
// THE RULE: within the scanned files, a raw `.eq('company_id', ...)` is fine
// ONLY when the file also calls the chokepoint (resolveCompanyId /
// resolveCompany / mergeCompanies / unmergeCompany / scanMergeCandidates)
// somewhere, or is pre-approved in ALLOWED_DIRECT_ACCESS for a read that is
// genuinely per-row (not company-level aggregate) — seeded HONESTLY below by
// grepping what exists today, not aspirationally.
//
// ponytail: file-level, not statement-level — a file earns "checked" by
// calling the chokepoint ANYWHERE, not by calling it at each raw call site.
// That is enough to catch a new file, or a new function in an unmigrated
// file, without hand-parsing statement boundaries; it would NOT catch a
// second, still-raw aggregate read added next to an already-migrated one in
// the SAME file. Tighten to statement-level if that gap is ever hit for real.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const WEB_ROOT = process.cwd()

function walk(dir: string, keep: (name: string) => boolean = (name) => name.endsWith('.ts')): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, keep))
    else if (keep(entry)) out.push(full)
  }
  return out
}

const isTest = (name: string) => name.includes('.test.')

/** The four places the audit named. matcher.ts is a single file; the rest are directories. */
const SCAN_ROOTS = [
  path.resolve(WEB_ROOT, 'lib/harness/agents/matcher.ts'),
  path.resolve(WEB_ROOT, 'lib/contacts'),
  path.resolve(WEB_ROOT, 'lib/dossier'),
  path.resolve(WEB_ROOT, 'app/api/contacts'),
  path.resolve(WEB_ROOT, 'app/api/companies'),
]

const scannedFiles = SCAN_ROOTS.flatMap((root) =>
  statSync(root).isDirectory()
    ? walk(root, (name) => name.endsWith('.ts') && !isTest(name))
    : [root]
)

const rel = (file: string) => path.relative(WEB_ROOT, file)

/**
 * Files allowed to query `.eq('company_id', ...)` raw, without calling the
 * chokepoint — seeded by grepping current reads (see the file header). Every
 * one of these is an ordinary per-row/ownership read, not a company-level
 * aggregate:
 *   - lib/contacts/sources.ts: looks up THIS user's already-known contacts at
 *     one company (to learn an email pattern) and checks whether one job
 *     belongs to one company — per-row, not "what does this company look
 *     like".
 *   - app/api/contacts/route.ts: plain list-contacts-for-a-company filter —
 *     same per-row shape as any other list endpoint's query param.
 */
const ALLOWED_DIRECT_ACCESS = new Set(['lib/contacts/sources.ts', 'app/api/contacts/route.ts'].map((p) => path.resolve(WEB_ROOT, p)))

const CHOKEPOINT_CALLS = ['resolveCompanyId', 'resolveCompany', 'mergeCompanies', 'unmergeCompany', 'scanMergeCandidates']

/**
 * Source with comment lines removed — same idiom as
 * lib/access/demo-chokepoints.test.ts's stripComments, and for the same
 * reason: without it, a file could satisfy this scan by mentioning
 * resolveCompanyId( in a comment near a raw filter, without ever calling it.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

function callsChokepoint(src: string): boolean {
  const code = stripComments(src)
  return CHOKEPOINT_CALLS.some((name) => new RegExp(`\\b${name}\\(`).test(code))
}

function rawCompanyIdFilter(src: string): boolean {
  return /\.eq\(\s*['"]company_id['"]/.test(stripComments(src))
}

describe('company identity — every company-keyed aggregate read routes through lib/entities/companies.ts', () => {
  it('finds files to check (a broken walk must not pass silently)', () => {
    expect(scannedFiles.length).toBeGreaterThan(5)
    expect(scannedFiles).toContainEqual(path.resolve(WEB_ROOT, 'lib/dossier/store.ts'))
  })

  it.each(scannedFiles.filter((f) => !ALLOWED_DIRECT_ACCESS.has(f)))('%s', (file) => {
    const src = readFileSync(file, 'utf8')
    if (!rawCompanyIdFilter(src)) return // nothing to guard in this file
    expect(
      callsChokepoint(src),
      `${rel(file)} queries company_id raw without calling the identity chokepoint ` +
        `(resolveCompanyId/resolveCompany/mergeCompanies/unmergeCompany/scanMergeCandidates from ` +
        `lib/entities/companies.ts) — either route it through the chokepoint or, if this really is a ` +
        `per-row (non-aggregate) read, add it to ALLOWED_DIRECT_ACCESS with a reason.`
    ).toBe(true)
  })

  it('the two migrated aggregate reads actually call the chokepoint', () => {
    const dossier = readFileSync(path.resolve(WEB_ROOT, 'lib/dossier/store.ts'), 'utf8')
    expect(callsChokepoint(dossier)).toBe(true)

    const contactsSource = readFileSync(path.resolve(WEB_ROOT, 'app/api/contacts/source/route.ts'), 'utf8')
    expect(callsChokepoint(contactsSource)).toBe(true)
  })
})
