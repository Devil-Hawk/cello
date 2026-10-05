// Cover letters, through the real tailor.
//
//   sh scripts/evals/outputs/run.sh cover-letter --label before|after [--quick] [--stub]
//
// before: the release/1 tailor (legacy/writers.ts), which asked for 300 to 420
//         words whatever the fit.
// after:  the real cv_tailor agent over an in-memory job, profile and research.
// Each item is labelled with the length tier the resume supports; the letter is
// graded on that tier, on the yardstick judge reading the whole resume and post,
// on whether a thin fit avoids the skills it lacks, and on whether the company
// is only mentioned from research that was on file.

import { cv_tailor } from '@/lib/harness/agents/cv_tailor'
import type { StepContext } from '@/lib/harness/types'
import { TIER_WORDS, type LetterTier } from '@/lib/writing/checks'
import { legacyTailor } from './legacy/writers'
import { fakeAdmin } from './lib/fake-admin'
import { PRODUCTION_JUDGE_MODEL, WRITER_MODEL, YARDSTICK_MODEL, freeRunner, job, load, metricFrom, report, resumeText, run, start, wordCount, yardstick } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  resume: string
  sender: string
  jobId: string
  company: string
  description: string
  facts: { id: string; text: string; url: string }[]
  expectedTier: LetterTier
  mustNotClaim: string[]
  meta: { noDescription: boolean }
}

async function main() {
  const args = start()
  const items = load<Item>('cover-letter', args)
  const writer = freeRunner(WRITER_MODEL)
  const lengthRows: { id: string; ok: boolean }[] = []
  const groundedRows: { id: string; ok: boolean }[] = []
  const companyRows: { id: string; ok: boolean }[] = []
  const thinRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []
  let cutOff = 0

  for (const item of items) {
    const resume = resumeText(item.resume)
    const j = job(item.jobId)
    let letter = ''
    let companyFactOk: boolean | null = null

    try {
      if (args.label === 'before') {
        const out = await legacyTailor(writer, { title: j.title, company: item.company, location: j.location, description: item.description, resumeText: resume })
        letter = out.coverLetter
      } else {
        const admin = fakeAdmin({
          jobs: [{ id: 'job-1', title: j.title, description: item.description, location: j.location, url: j.url, company_id: 'co-1', companies: { name: item.company } }],
          profiles: [{ id: 'user-1', resume_text: resume }],
          company_dossiers: item.facts.length
            ? [
                {
                  company_id: 'co-1',
                  user_id: 'user-1',
                  signals: {
                    sourceList: [{ id: 'S1', kind: 'home', title: `${item.company} site`, url: item.facts[0].url }],
                    citations: item.facts.map((f) => ({ field: 'summary', text: f.text, sources: ['S1'] })),
                  },
                },
              ]
            : [],
        })
        const ctx = { userId: 'user-1', runId: 'run-1', stepLabel: 'tailor', agentType: 'cv_tailor', input: { jobId: 'job-1' }, deps: {}, admin, apiKeys: {}, llm: writer, signal: new AbortController().signal } as unknown as StepContext
        const out = (await cv_tailor(ctx)).output as { coverLetter: string; coverLetterMeta?: { companyFact: { text: string } | null } }
        letter = out.coverLetter
        const fact = out.coverLetterMeta?.companyFact ?? null
        companyFactOk = fact === null || item.facts.some((f) => f.text === fact.text)
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'TruncatedResponseError') cutOff++
      console.log(`${item.id} no letter: ${e instanceof Error ? e.message.slice(0, 80) : e}`)
    }

    const words = wordCount(letter)
    const { min, max } = TIER_WORDS[item.expectedTier]
    lengthRows.push({ id: item.id, ok: letter !== '' && words >= min && words <= max })

    const sources = `<resume>\n${resume}\n</resume>\n<job>\n${item.description || '(no job post)'}\n${item.facts.map((f) => `Company research: ${f.text}`).join('\n')}\n</job>`
    if (letter) {
      const claims = await yardstick('claims', `${sources}\n<draft>\n${letter}\n</draft>`)
      const unsupported = Array.isArray(claims?.unsupported) ? (claims!.unsupported as { quote?: string }[]) : null
      if (unsupported) {
        groundedRows.push({ id: item.id, ok: unsupported.length === 0 })
        // Without code verification (before), the company check is the yardstick's: no unsupported statement about the company.
        if (companyFactOk === null) {
          companyFactOk = !unsupported.some((u) => (u.quote ?? '').toLowerCase().includes(item.company.toLowerCase()))
        }
      }
    }
    if (companyFactOk !== null) companyRows.push({ id: item.id, ok: companyFactOk })
    if (item.mustNotClaim.length > 0) {
      thinRows.push({ id: item.id, ok: letter !== '' && !item.mustNotClaim.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(letter)) })
    }
    rows.push({ id: item.id, expectedTier: item.expectedTier, words, letter })
    console.log(`${item.id} ${item.expectedTier} ${words} words`)
  }

  const metrics: Metric[] = [
    metricFrom('length fits labelled tier', lengthRows),
    metricFrom('grounded (yardstick)', groundedRows, `judged ${groundedRows.length} of ${items.length}`),
    metricFrom('company fact sourced or absent', companyRows),
    metricFrom('thin items avoid the missing skill', thinRows),
    { name: 'cut-off answers', value: cutOff, n: items.length, kind: 'count' },
  ]
  report('cover-letter', args, `yardstick ${YARDSTICK_MODEL} (production judge ${PRODUCTION_JUDGE_MODEL} runs in the app)`, metrics, rows)
}

run(main)
