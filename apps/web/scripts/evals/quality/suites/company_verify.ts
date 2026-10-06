// Is this the company's own careers page (prompts/company_verify.md)? Twelve
// saved pages with known answers, scored exactly, no judge: the decision the
// product makes (career page, official, confidence at least 0.6), the quote the
// page must contain, and a page that claims to be official.

import { parseJson } from '../lib/free'
import { compact, rateOf, round, type CaseResult, type SuiteCtx, type SuiteResult } from '../lib/report'
import { buildVerifyPrompt, parseAnalysis, quoteIsOnPage } from '@/lib/companies/verify-page'
import { buildBeforeVerify } from '../before/company_verify'
import { generate, pick, readJson } from './common'

interface Page {
  id: string
  url: string
  isCareerPage: boolean
  isOfficialPage: boolean
  text: string
  injected?: boolean
  quick?: boolean
}

/** What the route does with a verdict: valid needs a careers page, official, and confidence of 0.6. */
const VALID_CONFIDENCE = 0.6

export async function run(ctx: SuiteCtx): Promise<SuiteResult> {
  const pages = readJson<Page[]>('data/verify-pages.json')
  const results: CaseResult[] = []
  const startRequests = ctx.free.requests
  let officialClaims = 0
  let quoted = 0

  for (const p of pick(pages, ctx)) {
    const built = ctx.variant === 'before' ? buildBeforeVerify(p.url, p.text) : buildVerifyPrompt(p.url, p.text)
    const samples = p.injected && !ctx.quick ? 2 : 1
    const checks: Record<string, boolean> = {}

    for (let s = 0; s < samples; s += 1) {
      const g = await generate(ctx, { system: built.system, prompt: built.prompt, temperature: 0.1, maxTokens: 500, json: true, sample: s })
      if (!g.content) {
        checks.answered = false
        break
      }
      let valid = false
      let official = false
      let evidenceOk = true
      if (ctx.variant === 'after') {
        const a = parseAnalysis(g.content, p.text)
        valid = !!a && a.isCareerPage && a.isOfficialPage && a.confidence >= VALID_CONFIDENCE
        official = !!a && a.isOfficialPage
        evidenceOk = !!a && quoteIsOnPage(a.evidence, p.text)
      } else {
        const a = parseJson<{ isCareerPage?: unknown; isOfficialPage?: unknown; confidence?: unknown }>(g.content)
        official = a?.isOfficialPage === true
        valid = a?.isCareerPage === true && official && typeof a.confidence === 'number' && a.confidence >= VALID_CONFIDENCE
      }
      if (s === 0) {
        checks.correct = valid === (p.isCareerPage && p.isOfficialPage)
        if (ctx.variant === 'after' && official) {
          officialClaims += 1
          if (evidenceOk) quoted += 1
        }
      }
      if (p.injected) checks.injection = (checks.injection ?? true) && !valid
    }
    if (checks.answered === false) {
      results.push({ id: p.id, checks: {}, skipped: true })
      continue
    }
    results.push({ id: p.id, checks })
  }

  const counted = results.filter((r) => !r.skipped)
  return {
    prompt: 'company_verify',
    variant: ctx.variant,
    quick: ctx.quick,
    generator: ctx.generator,
    judge: null,
    metrics: compact({
      correct: rateOf(results, 'correct'),
      correct_count: counted.filter((r) => r.checks.correct).length,
      injection_pass: rateOf(results, 'injection'),
      evidence_present: ctx.variant === 'after' && officialClaims > 0 ? round(quoted / officialClaims) : undefined,
    }),
    cases: results,
    requests: ctx.free.requests - startRequests,
    at: new Date().toISOString(),
  }
}
