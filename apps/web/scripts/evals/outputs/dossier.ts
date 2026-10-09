// Company research and the visa signal, through the real synthesis.
//
//   sh scripts/evals/outputs/run.sh dossier --label before|after [--quick] [--stub]
//
// Eight frozen bundles (five real companies, plus careers-only, Wikipedia-only
// and a page that tries to instruct the model) and four careers texts.
//
// before: the release/1 synthesis (legacy/writers.ts): one prompt cut at 12,000
//         characters, 700 tokens, the Wikipedia extract shown when the model failed.
// after:  synthesizeDossier: numbered excerpts with their own budgets, cited
//         statements verified in code, one wider retry.

import { buildExcerpts, synthesizeDossier } from '@/lib/harness/agents/company_researcher'
import { parseCareersSponsorship } from '@/lib/dossier/visa'
import type { PublicSignals } from '@/lib/dossier/sources'
import { legacyResearch, legacyVisa } from './legacy/writers'
import { WRITER_MODEL, YARDSTICK_MODEL, freeRunner, metricFrom, readJsonl, report, run, start, yardstick } from './lib/evalkit'
import { dataDir } from './lib/report'
import type { Metric } from './lib/report'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Bundle {
  id: string
  kind: 'real' | 'synthetic'
  injectionMarker?: string
  company: { id: string; name: string; domain: string | null }
  pub: PublicSignals
}
interface VisaItem {
  id: string
  label: 'likely' | 'unlikely' | 'unknown'
  text: string
}

const FUNDING = /(series [a-e]\b|raised|funding|investors?|\$\d+(?:\.\d+)?\s?(?:m|million|b|billion)\b)/i

async function main() {
  const args = start()
  const bundles = JSON.parse(readFileSync(join(dataDir('dossier', args), 'bundles.json'), 'utf8')) as Bundle[]
  const visaItems = readJsonl<VisaItem>(join(dataDir('visa', args), 'items.jsonl'))
  const writer = freeRunner(WRITER_MODEL)
  const unsupportedRows: { id: string; ok: boolean }[] = []
  const fundingRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []
  let cutOff = 0
  let injectionFollowed = 0
  let wikipediaAsSummary = 0
  let wikipediaOnlyOk: boolean | null = null

  for (const b of bundles) {
    const excerptText = [b.pub.homeText, b.pub.aboutText, b.pub.careersText, b.pub.wikipediaSummary, b.pub.github?.description, ...b.pub.news.map((n) => n.title)].filter(Boolean).join('\n')
    let shown = ''
    let funding: string | null = null

    if (args.label === 'before') {
      const out = await legacyResearch(writer, b.company, { ...b.pub, news: b.pub.news })
      if (out.cutOff) cutOff++
      if (out.modelSummary === null && out.shownSummary && out.shownSummary === b.pub.wikipediaSummary) wikipediaAsSummary++
      shown = out.shownSummary ?? ''
      funding = out.funding
      if (b.id === 'wikipedia-only') wikipediaOnlyOk = false // nothing labels it
    } else {
      const out = await synthesizeDossier(writer, b.company, b.pub)
      if (!out.ok) {
        if (/cut off/i.test(out.status.detail ?? '')) cutOff++
      } else {
        const s = out.synthesis
        shown = [s.summary, s.whatTheyWant, s.funding, s.headcountTrend, s.culture, s.techStack.join(', ')].filter(Boolean).join('\n')
        funding = s.funding
      }
      if (b.id === 'wikipedia-only') {
        const kinds = new Set(buildExcerpts(b.company, b.pub).map((e) => e.kind))
        wikipediaOnlyOk = kinds.size === 1 && kinds.has('wikipedia')
      }
    }

    if (b.injectionMarker && (shown.includes(b.injectionMarker) || /sequoia|\$500\s?m/i.test(shown))) injectionFollowed++
    if (!FUNDING.test(excerptText)) fundingRows.push({ id: b.id, ok: !funding })
    if (shown) {
      const verdict = await yardstick('facts', `<excerpts>\n${excerptText.slice(0, 14000)}\n</excerpts>\n<note>\n${shown}\n</note>`)
      if (Array.isArray(verdict?.unsupported)) unsupportedRows.push({ id: b.id, ok: (verdict!.unsupported as unknown[]).length === 0 })
    }
    rows.push({ id: b.id, shown, funding })
    console.log(`${b.id} shown=${shown.length} chars`)
  }

  // The visa signal: a stance needs a quote, and the quote has to be on the page.
  const visaLabel: { id: string; ok: boolean }[] = []
  const visaQuote: { id: string; ok: boolean }[] = []
  for (const v of visaItems) {
    let result: { signal: string; evidence?: string } | null = null
    try {
      result = args.label === 'before' ? await legacyVisa(writer, v.text) : await parseCareersSponsorship(v.text, writer)
    } catch {
      result = null
    }
    if (!result) continue
    visaLabel.push({ id: v.id, ok: result.signal === v.label })
    if (result.signal !== 'unknown') {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
      visaQuote.push({ id: v.id, ok: !!result.evidence && norm(v.text).includes(norm(result.evidence)) })
    }
  }

  const metrics: Metric[] = [
    metricFrom('funding null when unstated', fundingRows),
    { name: 'bundles with an unsupported statement (yardstick)', value: unsupportedRows.filter((r) => !r.ok).length, n: unsupportedRows.length, kind: 'count', failures: unsupportedRows.filter((r) => !r.ok).map((r) => r.id) },
    { name: 'cut-off answers', value: cutOff, n: bundles.length, kind: 'count' },
    { name: 'injection followed', value: injectionFollowed, n: 1, kind: 'count' },
    { name: 'wikipedia shown as the summary', value: wikipediaAsSummary, n: bundles.length, kind: 'count' },
    { name: 'wikipedia-only is labelled', value: wikipediaOnlyOk ? 1 : 0, n: 1, kind: 'rate' },
    metricFrom('visa quote is on the page', visaQuote),
    metricFrom('visa label accuracy', visaLabel),
  ]
  report('dossier', args, `yardstick ${YARDSTICK_MODEL}`, metrics, rows)
}

run(main)
