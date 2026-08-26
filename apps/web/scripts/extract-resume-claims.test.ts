// The garbage-in guard for scripts/extract-resume-claims.ts's claim_evidence
// writes — see that script's header for the full contract. quotePassesContainment
// is a thin reuse of lib/security/job-text.ts#checkTailoringContainment (the
// quote stands in for "tailored" text, the source document for "resume"), so
// this file pins the guard's behavior on the shapes the script actually feeds
// it: a literal excerpt, a paraphrase, and a fabricated fact — rather than
// re-testing checkTailoringContainment itself (see lib/security/job-text.test.ts
// and lib/evals/fabrication.eval.test.ts for that).

import { describe, expect, it } from 'vitest'
import { quotePassesContainment } from './extract-resume-claims'

const RESUME = `Jane Okafor
Seattle, WA

WORK EXPERIENCE

Globex Corporation - Senior Engineer - 2018 - 2023
Led the payments migration to Kubernetes.
Cut checkout latency by 62% across the payments path.

EDUCATION
Bachelor of Science, Computer Science, University of Washington, 2018

SKILLS
Python, PostgreSQL, Docker`

describe('quotePassesContainment — the extraction script fixtures', () => {
  it('accepts a verbatim excerpt copied character-for-character from the source', () => {
    expect(quotePassesContainment(RESUME, 'Led the payments migration to Kubernetes.')).toBe(true)
  })

  it('accepts a verbatim excerpt with different surrounding whitespace', () => {
    expect(quotePassesContainment(RESUME, '  Cut checkout latency by 62% across the payments path.  ')).toBe(true)
  })

  it('rejects an empty or whitespace-only quote', () => {
    expect(quotePassesContainment(RESUME, '')).toBe(false)
    expect(quotePassesContainment(RESUME, '   ')).toBe(false)
  })

  it('rejects a quote that introduces a credential the source never states', () => {
    expect(quotePassesContainment(RESUME, 'Holds an active TS/SCI security clearance.')).toBe(false)
  })

  it('rejects a quote naming an employer the source never mentions', () => {
    expect(quotePassesContainment(RESUME, 'Staff engineer at Meta, leading platform reliability.')).toBe(false)
  })

  it('rejects an inflated years-of-experience quote the source figure does not support', () => {
    // The source's only stated tenure is one 2018-2023 role — no explicit
    // "N years" figure at all, so any spelled-out figure is unsupported.
    expect(quotePassesContainment(RESUME, 'Ten years leading platform engineering teams.')).toBe(false)
  })

  it('KNOWN GAP, documented not fixed here: a fluent paraphrase built entirely from the source\'s own proper nouns passes, even though it is not a literal substring', () => {
    // checkTailoringContainment (reused as-is, per this script's header) only
    // flags a HARD_FACT/CREDENTIAL token the source doesn't already contain —
    // it was never built to prove "this exact string appears verbatim". Every
    // capitalized/numeric token here ("Kubernetes") is already in RESUME, so
    // nothing trips the guard, and this quote is accepted despite never
    // appearing in the source. Accepted deliberately, same asymmetry
    // findInventedFacts documents about itself (lib/resume/import/llm.ts):
    // the guard is biased toward rejecting an honest paraphrase (see the
    // verbatim-with-whitespace case above) over accepting a fabrication
    // (see every credential/employer/years case above, all correctly
    // rejected) — a NEW proper noun or figure is what it catches, and a
    // paraphrase that introduces neither is outside what it promises to
    // catch. Recorded here so a future strengthening of this guard has a
    // regression to flip, not a silent behavior change.
    expect(quotePassesContainment(RESUME, 'Migrated the payments platform onto Kubernetes infrastructure.')).toBe(true)
  })
})
