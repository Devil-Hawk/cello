// Measure the two ingestion prompts, before and after, on free OpenRouter models.
//
//   cd apps/web && npx tsx scripts/eval-ingest.ts [pages|requirements|all] [--models a,b] [--prompts before,after] [--judge model]
//
// Careers page reader (prompts/page_reader.md): 14 saved pages (see
// eval-ingest/build-pages.ts). "before" is the prompt the Python reader sent,
// ported verbatim (eval-ingest/legacy.ts); both answers go through the same
// page check (lib/ingest/snapshot.ts verifyModelJobs), so the numbers are what
// would have been stored.
//
// Requirements reader (prompts/requirements.md): 35 postings (30 the parser
// could not split, 5 that ask for nothing). "before" is the prompt as it stood at
// b195472 (eval-ingest/prompts/requirements.v1.md). Both answers go through the
// production grounding (groundModelAnswer). A judge from another model family
// says whether each grounded item is something the posting asks of a candidate.
//
// Free models only, temperature 0, answers cached under eval-ingest/.cache, no
// database writes. If the account's free-model daily limit runs out the run
// stops and reports what it measured so far; rerun after the reset and the cache
// makes it pick up where it left off.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { composeSystemPrompt } from '../lib/harness/prompts'
import { parseJsonLoose } from '../lib/harness/llm'
import { answerToJobs, pageReaderSystemPrompt, pageReaderUserPrompt, parsePageAnswer, type PageAnswer } from '../lib/ingest/page-reader'
import { normalizeJobUrl, snapshotPage, verifyModelJobs, type ModelPageAnswer } from '../lib/ingest/snapshot'
import { ModelAnswerSchema, groundModelAnswer, parseRequirements } from '../lib/jobs/requirements'
import { requirementsSystemPrompt, requirementsUserPrompt } from '../lib/jobs/requirements-model'
import { chat, QuotaError } from './eval-ingest/openrouter'
import { legacyPageReaderPrompt, parseLegacyAnswer } from './eval-ingest/legacy'
import { scorePages, scoreRequirements, type PageRun, type ReqRun } from './eval-ingest/score'

const DIR = path.join(__dirname, 'eval-ingest')
const GENERATORS = ['google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free']
const JUDGE = 'nvidia/nemotron-3-super-120b-a12b:free'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const what = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all'
const models = (arg('models') ?? GENERATORS.join(',')).split(',')
const versions = (arg('prompts') ?? 'before,after').split(',') as ('before' | 'after')[]
const judgeModel = arg('judge') ?? JUDGE

interface PageEntry {
  id: string
  kind: string
  url: string
  file: string
  truth: string[] | null
  pageKinds: string[]
  forbidden?: string[]
}

let quotaHit = false

/** Run `fn` over items two at a time; once the daily limit is hit, stop starting new ones. */
async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (!quotaHit) {
        const i = next++
        if (i >= items.length) return
        try {
          out[i] = await fn(items[i])
        } catch (e) {
          if (e instanceof QuotaError) quotaHit = true
          else throw e
        }
      }
    })
  )
  return out.filter((x) => x !== undefined)
}

// --- careers page reader -----------------------------------------------------

async function evalPages() {
  const entries = JSON.parse(readFileSync(path.join(DIR, 'pages.json'), 'utf8')) as PageEntry[]
  const report: Record<string, unknown> = {}

  for (const model of models) {
    for (const version of versions) {
      const runs = await pool(entries, async (e): Promise<PageRun> => {
        const html = readFileSync(path.join(DIR, 'pages', e.file), 'utf8')
        const snap = snapshotPage(html, e.url)
        const user = version === 'before' ? legacyPageReaderPrompt(snap) : pageReaderUserPrompt(new URL(e.url).hostname, snap)
        // The old reader sent one user message and no system prompt.
        const system = version === 'before' ? '' : pageReaderSystemPrompt()
        const res = await chat({ model, system, user, maxTokens: 3000 })
        if (!res.content) return { caseId: e.id, valid: false, returned: 0, kept: [], dropped: 0 }

        if (version === 'before') {
          const items = parseLegacyAnswer(res.content)
          if (!items) return { caseId: e.id, valid: false, returned: 0, kept: [], dropped: 0 }
          // The old answer carried urls, not link numbers: map each back to the page's own link, or it names none.
          const answer: ModelPageAnswer = {
            page_kind: items.length > 0 ? 'listing' : 'no_postings',
            jobs: items.map((it) => {
              let abs = it.url
              try {
                abs = new URL(it.url, snap.url).toString()
              } catch {
                /* keep as written */
              }
              const n = snap.links.findIndex((l) => normalizeJobUrl(l.href) === normalizeJobUrl(abs)) + 1
              return { title: it.title, link: n > 0 ? n : null }
            }),
          }
          const v = verifyModelJobs(answer, snap)
          return { caseId: e.id, valid: true, returned: items.length, kept: v.kept.map((j) => j.title), dropped: v.dropped }
        }

        const answer: PageAnswer | null = parsePageAnswer(res.content)
        if (!answer) return { caseId: e.id, valid: false, returned: 0, kept: [], dropped: 0 }
        const r = answerToJobs(answer, snap)
        return { caseId: e.id, valid: true, returned: r.named, kept: r.jobs.map((j) => j.title), dropped: r.dropped }
      })
      report[`${model} | ${version}`] = scorePages(entries, runs)
    }
  }
  return report
}

// --- requirements reader -----------------------------------------------------

interface PostingEntry {
  id: string
  kind: 'prose' | 'blurb'
  title: string
  description: string
}

const JUDGE_SYSTEM =
  'You check a list that was read out of one job posting. For each item, answer true only if the posting asks this of a candidate ' +
  '(a skill, tool, qualification, certification or kind of experience the person must or should bring) and the item is in the right list: ' +
  '"must_have" for what the posting presents as required, "nice_to_have" for what it presents as preferred or a plus. ' +
  'A duty the person will perform, a benefit, a company fact or a description of the team is false. ' +
  'Reply with one JSON object and nothing else: {"must_have": [true or false per item, in order], "nice_to_have": [true or false per item, in order]}.'

function judgeUser(p: PostingEntry, must: string[], nice: string[]): string {
  return `Posting for "${p.title}":\n\n${p.description.slice(0, 8000)}\n\nmust_have items:\n${JSON.stringify(must)}\n\nnice_to_have items:\n${JSON.stringify(nice)}`
}

async function evalRequirements() {
  const postings = JSON.parse(readFileSync(path.join(DIR, 'postings.json'), 'utf8')) as PostingEntry[]
  const beforeDoc = readFileSync(path.join(DIR, 'prompts', 'requirements.v1.md'), 'utf8').trim()
  const beforeSystem = composeSystemPrompt({ mode: beforeDoc, includeVoice: false })
  const afterSystem = requirementsSystemPrompt()
  const report: Record<string, unknown> = {}

  for (const model of models) {
    for (const version of versions) {
      const runs = await pool(postings, async (p): Promise<ReqRun> => {
        const user = version === 'before' ? `Role title: ${p.title.trim()}\n\n<posting>\n${p.description.slice(0, 12_000)}\n</posting>` : requirementsUserPrompt(p.title, p.description)
        const res = await chat({ model, system: version === 'before' ? beforeSystem : afterSystem, user, maxTokens: 700 })
        const base = { caseId: p.id, kind: p.kind, keptMust: [] as string[], keptNice: [] as string[] }
        if (!res.content) return { ...base, valid: false, returned: 0 }
        let parsed: unknown = null
        try {
          parsed = parseJsonLoose(res.content)
        } catch {
          return { ...base, valid: false, returned: 0 }
        }
        const answer = ModelAnswerSchema.safeParse(parsed)
        if (!answer.success) return { ...base, valid: false, returned: 0 }
        const returned = answer.data.must_have.length + answer.data.nice_to_have.length
        const start = parseRequirements({ title: p.title, description: p.description })
        const grounded = groundModelAnswer(start, p.description, answer.data)
        const kept = grounded === start ? { must: [] as string[], nice: [] as string[] } : { must: grounded.must_have, nice: grounded.nice_to_have }
        const run: ReqRun = { ...base, valid: true, returned, keptMust: kept.must, keptNice: kept.nice }
        if (kept.must.length + kept.nice.length > 0) {
          const j = await chat({ model: judgeModel, system: JUDGE_SYSTEM, user: judgeUser(p, kept.must, kept.nice), maxTokens: 400 })
          try {
            const verdict = j.content ? (parseJsonLoose(j.content) as { must_have?: unknown[]; nice_to_have?: unknown[] }) : null
            if (verdict) {
              // One verdict per item, in order; any extra the judge adds is ignored.
              const yes = (flags: unknown[] | undefined, n: number) => (flags ?? []).slice(0, n).filter((f) => f === true).length
              run.judge = {
                yes: yes(verdict.must_have, kept.must.length) + yes(verdict.nice_to_have, kept.nice.length),
                total: kept.must.length + kept.nice.length,
              }
            }
          } catch {
            /* an unreadable verdict is not counted */
          }
        }
        return run
      })
      report[`${model} | ${version}`] = scoreRequirements(runs)
    }
  }
  return report
}

async function main() {
  const out: Record<string, unknown> = { generators: models, judge: judgeModel, at: new Date().toISOString() }
  if (what === 'pages' || what === 'all') out.careersPage = await evalPages()
  if (what === 'requirements' || what === 'all') out.requirements = await evalRequirements()
  if (quotaHit) out.stopped = 'the free-model daily request limit was reached; rerun after the reset, answers so far are cached'
  console.log(JSON.stringify(out, null, 2))
  const file = process.env.EVAL_RESULTS ?? path.join(DIR, 'results.json')
  const previous = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
  writeFileSync(file, JSON.stringify({ ...previous, ...out }, null, 2) + '\n')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
