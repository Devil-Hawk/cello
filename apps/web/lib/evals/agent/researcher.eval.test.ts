// The Researcher on saved pages: 8 cases (6 with enough to say, 2 thin), on two free generators, judged for
// groundedness by a third model from a different family.
//
// Code checks: every source url is a page it could have read (citation validity), every number in the summary
// is on a page it read, every paragraph carries a citation, the summary is at most 250 words, a thin case
// refuses (empty summary, enough_information false), and the loop stays within 8 model calls.
// MODE old scores the earlier company dossier prompt (company cases only) on the same pages, with the checks
// that apply to it (numbers on a page, refusal when thin, groundedness); it has no sources to check.
//
// OPT-IN, LIVE (free models only). See tool-selection.eval.test.ts for how to run it.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface Page {
  url: string
  title: string
  text: string
}
interface Fixture {
  id: string
  subject: string
  kind: 'company' | 'person' | 'topic'
  thin: boolean
  pages: Page[]
  distractor: Page
}

const state = vi.hoisted(() => ({ active: null as null | { pages: { url: string; title: string; text: string }[]; distractor: { url: string; title: string; text: string } } }))

vi.mock('@/lib/search', () => ({
  webSearch: async () => {
    const a = state.active
    const results = a ? [a.distractor, ...a.pages].map((p) => ({ title: p.title, url: p.url, snippet: p.text.slice(0, 140) })) : []
    return { ok: true, backend: 'eval-fixtures', results }
  },
}))
vi.mock('@/lib/security/untrusted', async (orig) => ({ ...(await orig<typeof import('@/lib/security/untrusted')>()), checkSsrf: async () => ({ ok: true }) }))

import { composeSystemPrompt, loadModeDoc } from '@/lib/harness/prompts'
import { freeComplete, GENERATORS, JUDGE, mapLimit, parseJson, RUN_LIVE, stats, writeReport } from './free'
import { runResearcherCase } from './run'

const DIR = path.join(__dirname, 'fixtures', 'researcher')
const fixtures: Fixture[] = readdirSync(DIR).sort().map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Fixture)
const MODE = (process.env.AGENT_EVAL_MODE ?? 'new') as 'old' | 'new'
const LABEL = process.env.AGENT_EVAL_LABEL ?? (MODE === 'old' ? 'before' : 'after')
const generators = GENERATORS.slice(0, 2)

const numbersIn = (text: string): string[] => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''))

interface Scored {
  numbersGrounded: boolean
  paragraphCitations: boolean | null
  words: number
  refused: boolean
}

function scoreSummary(fx: Fixture, summary: string, citations: boolean): Scored {
  const known = new Set(numbersIn(fx.pages.map((p) => p.text).join(' ')))
  const paragraphs = summary.split(/\n{2,}/).filter((p) => p.trim())
  return {
    numbersGrounded: numbersIn(summary).every((n) => known.has(n)),
    paragraphCitations: citations ? paragraphs.every((p) => /\([^)]+\)/.test(p)) : null,
    words: summary.trim() ? summary.trim().split(/\s+/).length : 0,
    refused: !summary.trim(),
  }
}

async function groundedness(fx: Fixture, summary: string): Promise<number> {
  if (!summary.trim()) return 1
  const raw = await freeComplete({
    model: JUDGE,
    system: 'You check a summary against the pages it was written from. Reply with only JSON.',
    user:
      `PAGES:\n${fx.pages.map((p) => `[${p.url}]\n${p.text}`).join('\n\n')}\n\nSUMMARY:\n${summary}\n\n` +
      'Split the summary into its separate factual claims. For each, decide whether the pages state it. ' +
      'Reply as {"total": <number of claims>, "supported": <number the pages state>, "unsupported": ["<claim>", ...]}.',
    json: true,
    maxTokens: 500,
  })
  const j = parseJson<{ total?: number; supported?: number }>(raw)
  return j && typeof j.total === 'number' && j.total > 0 ? Math.min(1, (j.supported ?? 0) / j.total) : 1
}

describe('researcher fixtures', () => {
  it('are eight: six with enough to say and two thin, each with two or more pages (one page when thin)', () => {
    expect(fixtures).toHaveLength(8)
    expect(fixtures.filter((f) => f.thin)).toHaveLength(2)
    for (const f of fixtures) expect(f.pages.length).toBe(f.thin ? 1 : 3)
  })

  it('scores a summary: numbers must be on a page, and each paragraph needs a citation', () => {
    const fx = fixtures[0]
    expect(scoreSummary(fx, 'It raised $48 million in 2025 (news).', true)).toMatchObject({ numbersGrounded: true, paragraphCitations: true })
    expect(scoreSummary(fx, 'It raised $50 million in 2025.', true)).toMatchObject({ numbersGrounded: false, paragraphCitations: false })
    expect(scoreSummary(fx, '', true)).toMatchObject({ refused: true, words: 0 })
  })
})

describe.skipIf(!RUN_LIVE)(`researcher (${MODE}, ${LABEL})`, () => {
  const realFetch = globalThis.fetch
  beforeAll(() => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const hit = state.active ? [state.active.distractor, ...state.active.pages].find((p) => p.url === url) : undefined
      if (hit) return Promise.resolve(new Response(`<html><head><title>${hit.title}</title></head><body>${hit.text}</body></html>`, { headers: { 'content-type': 'text/html' } }))
      return realFetch(input, init)
    })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it(
    'cites only what it read, invents no number, refuses when thin, stays in eight calls',
    async () => {
      const cases = MODE === 'old' ? fixtures.filter((f) => f.kind === 'company') : fixtures
      const rows: Record<string, unknown>[] = []
      // The fixtures are shared state for the search and page mocks, so cases run one at a time.
      for (const fx of cases) {
        state.active = { pages: fx.pages, distractor: fx.distractor }
        const urls = new Set(fx.pages.map((p) => p.url))
        const perModel = await mapLimit(generators, 1, async (model) => {
          try {
            if (MODE === 'old') {
              const system = composeSystemPrompt({ mode: loadModeDoc('company_researcher') })
              const user = [`COMPANY: ${fx.subject}`, `VERIFIED EVIDENCE AVAILABLE: ${fx.pages.length} page(s).`, ...fx.pages.map((p) => `OFFICIAL SITE OR NEWS (${p.title}):\n${p.text}`)].join('\n\n')
              const raw = await freeComplete({ model, system, user, json: true, maxTokens: 700 })
              const j = parseJson<{ summary?: string; uncertainty?: string | null }>(raw) ?? {}
              const summary = typeof j.summary === 'string' ? j.summary : ''
              const thinText = `${summary} ${j.uncertainty ?? ''}`
              const s = scoreSummary(fx, summary, false)
              return {
                model,
                summary,
                numbersGrounded: s.numbersGrounded,
                refused: s.refused || /not enough|thin|cannot verify|no (public )?information|limited/i.test(thinText),
                ground: await groundedness(fx, summary),
              }
            }
            const out = await runResearcherCase(model, fx.subject, fx.kind)
            const s = scoreSummary(fx, out.summary, true)
            return {
              model,
              summary: out.summary,
              sources: out.sources.map((x) => x.url),
              enough: out.enough_information,
              citationValid: out.sources.every((x) => urls.has(x.url)) && (!out.enough_information || out.sources.length >= 2),
              numbersGrounded: s.numbersGrounded,
              paragraphCitations: s.paragraphCitations,
              words: s.words,
              refused: !out.enough_information && !out.summary,
              steps: out.modelCalls,
              hitLimit: out.hit_step_limit,
              ground: await groundedness(fx, out.summary),
            }
          } catch (e) {
            return { model, error: e instanceof Error ? e.message.slice(0, 160) : String(e) }
          }
        })
        for (const r of perModel) rows.push({ id: fx.id, thin: fx.thin, ...r })
      }
      state.active = null

      const ok = rows.filter((r) => !r.error)
      const rich = ok.filter((r) => !r.thin)
      const thin = ok.filter((r) => r.thin)
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
      const share = (rs: Record<string, unknown>[], f: (r: Record<string, unknown>) => boolean) => (rs.length ? rs.filter(f).length / rs.length : 0)
      const summary = {
        runs: rows.length,
        errors: rows.length - ok.length,
        numbersGrounded: share(ok, (r) => r.numbersGrounded === true),
        refusalOnThin: share(thin, (r) => r.refused === true),
        answeredWhenRich: MODE === 'new' ? share(rich, (r) => r.enough === true) : share(rich, (r) => !r.refused),
        groundedness: mean(ok.map((r) => Number(r.ground ?? 0))),
        ...(MODE === 'new'
          ? {
              citationValidity: share(ok, (r) => r.citationValid === true),
              paragraphCitations: share(rich.filter((r) => r.summary), (r) => r.paragraphCitations === true),
              underWordLimit: share(ok, (r) => Number(r.words) <= 250),
              stepCap: share(ok, (r) => Number(r.steps) <= 8),
            }
          : {}),
      }
      const md = [`# Researcher: ${MODE} (${LABEL})`, '', '```', JSON.stringify(summary, null, 2), '```', '', '| case | model | enough | refused | numbers ok | groundedness | steps | sources |', '|---|---|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.id} | ${String(r.model).split('/')[1].split(':')[0]} | ${r.enough ?? ''} | ${r.refused ?? ''} | ${r.numbersGrounded ?? ''} | ${r.ground !== undefined ? Number(r.ground).toFixed(2) : r.error} | ${r.steps ?? ''} | ${Array.isArray(r.sources) ? r.sources.length : ''} |`)].join('\n')
      const paths = writeReport(`researcher-${MODE}-${LABEL}`, { mode: MODE, label: LABEL, generators, judge: JUDGE, summary, rows }, md)
      console.log(`\n${md}\n\nrequests: ${JSON.stringify(stats)}\nreport: ${paths.md}`)

      if (MODE === 'new' && process.env.AGENT_EVAL_GATE !== '0') {
        const t = JSON.parse(readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8')).researcher as Record<string, number>
        expect(summary.citationValidity, 'citation validity').toBeGreaterThanOrEqual(t.citation_validity)
        expect(summary.refusalOnThin, 'refusal on thin cases').toBeGreaterThanOrEqual(t.refusal)
        expect(summary.groundedness, 'groundedness').toBeGreaterThanOrEqual(t.groundedness)
        expect(summary.stepCap, 'within the step cap').toBeGreaterThanOrEqual(t.step_cap)
      }
    },
    3_600_000
  )
})
