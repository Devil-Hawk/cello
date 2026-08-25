// LLM-as-judge evals for the outreach draft — the sharpest case of a Cello
// output with no ground truth to diff against. A human reads this under the
// user's name; "is this actually about THIS company, or generic filler" and
// "does it claim something the resume/job facts never said" are judgement
// calls a programmatic scorer cannot make. See lib/evals/judge.ts for the
// autoevals wiring and why each judge is built the way it is.
//
// OPT-IN ONLY — THIS FILE MAKES REAL, BILLED API CALLS
//   Every other eval in lib/evals/ reads a committed fixture and costs
//   nothing. This one calls a real model (judge.ts's JUDGE_MODEL) through the
//   user's own OpenRouter key, so it is gated behind an explicit env var and
//   MUST NEVER run in CI — a judged gate that runs by accident spends the
//   user's money on every push, and one that fails for a missing/expired key
//   reads as a quality regression when it's actually a setup problem.
//
// HOW TO RUN (from apps/web):
//   RUN_JUDGE_EVALS=1 OPENROUTER_API_KEY=sk-or-... \
//     ./node_modules/.bin/vitest run lib/evals/judged.eval.test.ts
//
//   Without RUN_JUDGE_EVALS set, every test below reports skipped — this is
//   the expected, default state (confirmed by running the suite with no env
//   var set, see the commit that added this file).

import { beforeAll, describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import { buildJudgeClient, judgeGroundedness, judgeSpecificity } from './judge'
import { formatEvalResult } from './harness'

const RUN = Boolean(process.env.RUN_JUDGE_EVALS)
const HAS_KEY = Boolean(process.env.OPENROUTER_API_KEY)

if (RUN && !HAS_KEY) {
  // Printed at collection time (unconditionally, unlike the it.skipIf below)
  // so the reason is visible even in a run that skips every test.
  console.warn(
    '[judged-evals] RUN_JUDGE_EVALS is set but OPENROUTER_API_KEY is not — skipping every judged ' +
      'assertion. This is a missing key, not a quality regression.'
  )
}

// A single fictional job used across every case below, so the three drafts
// differ only in what they SAY, not in what they're being judged against.
const COMPANY_AND_ROLE = 'Anchorage Digital, Senior Platform Engineer (Custody Infrastructure team)'
const SOURCE_FACTS =
  "Resume: Priya Nair, 6 years building backend infrastructure in Go and Kubernetes. At her last " +
  'job (a fintech startup called Ledgerly) she led the migration of the payments API from a ' +
  'single-region Postgres cluster to a multi-region active-active setup. She has never worked at ' +
  'a custody or crypto company. ' +
  'Job post: Anchorage Digital is hiring a Senior Platform Engineer for the Custody Infrastructure ' +
  'team. The post states the team is mid-migration from a single-region Postgres cluster to a ' +
  'multi-region active-active setup, and lists Go and Kubernetes as the primary stack.'

// Could be pasted into an outreach message for any company hiring anyone —
// no detail here depends on Anchorage Digital or this role existing at all.
const GENERIC_DRAFT =
  "Hi there, I hope this message finds you well. I'm very interested in opportunities at your " +
  "company and I believe my background would be a great fit for your team. I'd love the chance to " +
  'connect and learn more about your organization and any open roles. Best regards, Priya'

// Specific to this job post AND consistent with the resume facts above —
// nothing here is asserted beyond what SOURCE_FACTS supports.
const SPECIFIC_DRAFT =
  'Hi, I saw the Senior Platform Engineer opening on the Custody Infrastructure team. At Ledgerly I ' +
  'led the migration of our payments API from a single-region Postgres cluster to multi-region ' +
  'active-active — the same shape of migration your team is mid-way through, from what the post ' +
  'describes, and in the same Go-on-Kubernetes stack. I\'d welcome the chance to talk about where ' +
  'the migration stands. Best, Priya'

// Sounds just as specific as SPECIFIC_DRAFT — names the team, references the
// exact migration — but asserts a fact SOURCE_FACTS directly contradicts
// (the resume says she has never worked at a custody or crypto company).
const HALLUCINATING_DRAFT =
  'Hi, I saw the Senior Platform Engineer opening on the Custody Infrastructure team. I actually ' +
  "spent two years at one of Anchorage Digital's custody competitors running this exact " +
  'active-active Postgres migration, so I already know this system inside out. I\'d love to bring ' +
  'that direct experience to your team. Best, Priya'

describe.skipIf(!RUN)('LLM-as-judge — outreach draft quality (real API calls, real cost)', () => {
  let client: OpenAI | undefined

  beforeAll(() => {
    // Guarded so a run with RUN_JUDGE_EVALS set but no key never throws out
    // of a hook — it.skipIf below turns that into a clean skip instead.
    if (HAS_KEY) client = buildJudgeClient({ openrouter: process.env.OPENROUTER_API_KEY })
  })

  it.skipIf(!HAS_KEY)('ranks a generic draft below a genuinely specific one on specificity', async () => {
    const generic = await judgeSpecificity(client!, { draft: GENERIC_DRAFT, companyAndRole: COMPANY_AND_ROLE })
    const specific = await judgeSpecificity(client!, { draft: SPECIFIC_DRAFT, companyAndRole: COMPANY_AND_ROLE })
    console.log(formatEvalResult(generic))
    console.log(formatEvalResult(specific))

    expect(generic.score, generic.summary).not.toBeNull()
    expect(specific.score, specific.summary).not.toBeNull()
    // The ordering, not just the pass/fail line: a judge that can't put these
    // two in the right order is not worth running regardless of threshold.
    expect(specific.score!).toBeGreaterThan(generic.score!)
    expect(specific.verdict).toBe('pass')
    expect(generic.verdict).not.toBe('pass')
  })

  it.skipIf(!HAS_KEY)('ranks a fact-inventing draft below a genuinely grounded one on groundedness', async () => {
    const grounded = await judgeGroundedness(client!, { draft: SPECIFIC_DRAFT, sourceFacts: SOURCE_FACTS })
    const hallucinating = await judgeGroundedness(client!, {
      draft: HALLUCINATING_DRAFT,
      sourceFacts: SOURCE_FACTS,
    })
    console.log(formatEvalResult(grounded))
    console.log(formatEvalResult(hallucinating))

    expect(grounded.score, grounded.summary).not.toBeNull()
    expect(hallucinating.score, hallucinating.summary).not.toBeNull()
    expect(grounded.score!).toBeGreaterThan(hallucinating.score!)
    expect(grounded.verdict).toBe('pass')
  })

  it.skipIf(!HAS_KEY)(
    'specificity alone does not catch the hallucinated fact — this is why groundedness runs too',
    async () => {
      // HALLUCINATING_DRAFT names the team and the exact migration, so a
      // specificity-only gate waves it through; only groundedness, diffing
      // against SOURCE_FACTS, sees the contradiction.
      const specificity = await judgeSpecificity(client!, {
        draft: HALLUCINATING_DRAFT,
        companyAndRole: COMPANY_AND_ROLE,
      })
      const groundedness = await judgeGroundedness(client!, {
        draft: HALLUCINATING_DRAFT,
        sourceFacts: SOURCE_FACTS,
      })
      console.log(formatEvalResult(specificity))
      console.log(formatEvalResult(groundedness))

      expect(specificity.verdict).toBe('pass')
      expect(groundedness.verdict).not.toBe('pass')
    }
  )
})
