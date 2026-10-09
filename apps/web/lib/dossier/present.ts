// How a dossier's cited statements are shown: each statement with numbered
// source marks, the numbered source list, and one line saying what the research
// rests on. Client-safe, so the panel and its test share it.

import type { CitedField, DossierSignals, ExcerptKind } from './store'

export interface ShownSource {
  n: number
  title: string
  url: string
}

export interface ShownStatement {
  text: string
  /** Source numbers, in order. */
  marks: number[]
}

export interface DossierView {
  summary: ShownStatement[]
  /** The cited source behind one of the optional fields, by field. */
  field: (f: Exclude<CitedField, 'summary' | 'techStack' | 'uncertainty'>) => ShownStatement | null
  /** Sources the statements cite, numbered by first use. */
  cited: ShownSource[]
  /** Sources that were read but not cited. */
  other: { title: string; url: string }[]
  evidenceLine: string | null
  wikipediaOnly: boolean
  dropped: number
  /** True when this research was written with citations (older rows were not). */
  hasCitations: boolean
}

const KIND_ORDER: ExcerptKind[] = ['home', 'about', 'careers', 'wikipedia', 'github', 'news']
const KIND_PHRASE: Record<Exclude<ExcerptKind, 'news'>, string> = {
  home: 'the company site',
  about: 'the about page',
  careers: 'the careers page',
  wikipedia: 'Wikipedia',
  github: 'GitHub',
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function evidenceLine(signals: DossierSignals | null | undefined): string | null {
  const list = signals?.sourceList ?? []
  if (list.length === 0) return null
  const parts: string[] = []
  for (const kind of KIND_ORDER) {
    const n = list.filter((s) => s.kind === kind).length
    if (n === 0) continue
    parts.push(kind === 'news' ? `${n} news ${n === 1 ? 'mention' : 'mentions'}` : KIND_PHRASE[kind])
  }
  return `Based on ${joinWords(parts)}.`
}

export function dossierView(signals: DossierSignals | null | undefined): DossierView {
  const sources = new Map((signals?.sourceList ?? []).map((s) => [s.id, s]))
  const numbering = new Map<string, number>()
  const mark = (ids: string[]): number[] =>
    ids
      .filter((id) => sources.has(id))
      .map((id) => {
        if (!numbering.has(id)) numbering.set(id, numbering.size + 1)
        return numbering.get(id)!
      })
  const shown = (c: { text: string; sources: string[] }): ShownStatement => ({ text: c.text, marks: mark(c.sources) })

  const citations = signals?.citations ?? []
  const summary = citations.filter((c) => c.field === 'summary').map(shown)
  const fields = new Map<string, ShownStatement>()
  for (const c of citations) if (c.field !== 'summary' && c.field !== 'techStack' && c.field !== 'uncertainty' && !fields.has(c.field)) fields.set(c.field, shown(c))

  const cited: ShownSource[] = [...numbering.entries()]
    .map(([id, n]) => ({ n, title: sources.get(id)!.title, url: sources.get(id)!.url }))
    .sort((a, b) => a.n - b.n)
  const citedIds = new Set(numbering.keys())
  const other = [...sources.values()].filter((s) => !citedIds.has(s.id) && s.url).map((s) => ({ title: s.title, url: s.url }))

  return {
    summary,
    field: (f) => fields.get(f) ?? null,
    cited,
    other,
    evidenceLine: evidenceLine(signals),
    wikipediaOnly: signals?.evidence?.wikipediaOnly === true,
    dropped: signals?.dropped ?? 0,
    hasCitations: citations.length > 0,
  }
}
