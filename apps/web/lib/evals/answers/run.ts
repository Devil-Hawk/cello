// The answers eval (measure S10). Four gates scored by code over questions.json, which is 120 screening
// questions from public Greenhouse forms, labelled by hand, with near pairs that must never match and
// work-authorization wordings with their right answer:
//
//   modelAnswers        values that came from anywhere but the profile, the two facts or a saved answer: 0
//   nearPairsMatched    a saved answer taken for a near pair's other question: 0
//   wrongWorkAuth       a work-authorization wording mapped to the wrong fact or polarity: 0
//   sensitiveRecall     sensitive questions the patterns call sensitive: at least 0.95
//
// Category accuracy is reported, not gated (the free model step covers what the patterns leave as
// "other"). The patterns need no model, so this makes no request (cap 150 stays unspent).
//
//   npx tsx lib/evals/answers/run.ts            prints the report
//   npx tsx lib/evals/answers/run.ts --record   also writes one measure_runs row for S10 (service role)

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { categorize, isSensitive, workAuthAnswer } from '../../answers/categories'
import { classify, findAnswer, type BankRow } from '../../answers/match'

interface Dataset {
  questions: { id: string; text: string; category: string }[]
  nearPairs: [string, string][]
  workAuth: { text: string; authorized: boolean | null; needsSponsorship: boolean | null; expect: boolean | null }[]
}

const here = path.dirname(new URL(import.meta.url).pathname)
const data = JSON.parse(readFileSync(path.join(here, 'questions.json'), 'utf8')) as Dataset
const gates = JSON.parse(readFileSync(path.join(here, 'thresholds.json'), 'utf8')) as Record<string, number>

const asBank = (text: string, answer: unknown): BankRow => {
  const a = classify({ id: 'f', label: text })
  return { id: 'x', question: text, question_key: a.key, category: a.category, sensitive: a.sensitive, specific: a.specific, kind: a.kind, options: null, answer, declined: false, company_id: null, source: 'person', source_ref: null, origin: 'person', confirmed_at: null }
}

export interface Report {
  questions: number
  categoryAccuracy: number
  sensitiveRecall: number
  nearPairsMatched: number
  wrongWorkAuth: number
  modelAnswers: number
  passed: boolean
  misses: string[]
}

export function run(): Report {
  const misses: string[] = []
  let right = 0
  let sensitive = 0
  let sensitiveCaught = 0
  for (const q of data.questions) {
    const got = categorize(q.text)
    if (got === q.category) right++
    else misses.push(`${q.text}: ${got}, labelled ${q.category}`)
    if (isSensitive(q.category as never)) {
      sensitive++
      if (isSensitive(got)) sensitiveCaught++
    }
  }

  let nearPairsMatched = 0
  for (const [a, b] of data.nearPairs) {
    for (const [saved, asked] of [[a, b], [b, a]]) {
      if (findAnswer([asBank(saved, 'Yes')], classify({ id: 'f', label: asked }), { companyId: null, applicationId: null })) {
        nearPairsMatched++
        misses.push(`near pair matched: ${saved} / ${asked}`)
      }
    }
  }

  let wrongWorkAuth = 0
  for (const w of data.workAuth) {
    const got = workAuthAnswer(w.text, { authorized: w.authorized, needsSponsorship: w.needsSponsorship })
    // an answer where the right one is open, or the opposite of the right one, is wrong; open where one exists is only slower
    if (got !== null && got !== w.expect) {
      wrongWorkAuth++
      misses.push(`work authorization: ${w.text} gave ${got}, expected ${w.expect}`)
    }
  }

  // A value is never a model's: nothing in lib/answers reaches a model, so no value can come from one.
  // Counted as the files there that import a model call.
  const dir = path.join(here, '../../answers')
  const modelAnswers = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => /callLlm|lib\/models|from 'ai'|@ai-sdk|openai|anthropic|defineModelStep/i.test(readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))).length

  const report: Report = {
    questions: data.questions.length,
    categoryAccuracy: right / data.questions.length,
    sensitiveRecall: sensitive ? sensitiveCaught / sensitive : 1,
    nearPairsMatched,
    wrongWorkAuth,
    modelAnswers,
    passed: false,
    misses,
  }
  report.passed =
    report.modelAnswers <= gates.modelAnswers &&
    report.nearPairsMatched <= gates.nearPairsMatched &&
    report.wrongWorkAuth <= gates.wrongWorkAuth &&
    report.sensitiveRecall >= gates.sensitiveRecallMin
  return report
}

async function main() {
  const r = run()
  console.log(JSON.stringify({ ...r, misses: undefined }, null, 2))
  for (const m of r.misses) console.log(' -', m)
  if (process.argv.includes('--record')) {
    const { createAdminClient } = await import('../../harness/supabase-admin')
    const { error } = await createAdminClient().from('measure_runs').insert({
      measure_id: 'S10',
      value: r.sensitiveRecall,
      passed: r.passed,
      sample_n: r.questions,
      note: `sensitive recall ${r.sensitiveRecall.toFixed(3)}; near pairs matched ${r.nearPairsMatched}; wrong work authorization ${r.wrongWorkAuth}; model answers ${r.modelAnswers}; category accuracy ${r.categoryAccuracy.toFixed(3)}. Hand-labelled set; patterns only, no model call.`,
    })
    if (error) throw new Error('could not record the run')
  }
  if (!r.passed) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
