// Wikidata as a source of facts about an employer: its official website and a few profile facts, each from a named public
// record and stamped with the time Cello read it. Fetch only, no key, no model.
//
// A match counts only when the item has an official website (P856): that drops the fruit, the film and the surname that
// share a company's label. The website is a lead, never proof: find.ts puts its domain through the same proof as a pasted link.

import { CELLO_USER_AGENT } from '../ats/http'

const API = 'https://www.wikidata.org/w/api.php'
const PROPS = ['P856', 'P159', 'P1128', 'P452', 'P154', 'P571', 'P249', 'P2037'] as const
/** Two-part public suffixes the registrable domain keeps whole (co.uk, com.au). ponytail: a short list, not the Public Suffix List; add tldts when a suffix is missed. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'])

export interface WikidataEntity {
  qid: string
  label: string
  website: string
  hq: string | null
  employees: number | null
  industry: string | null
  logo: string | null
  founded: number | null
  ticker: string | null
  github: string | null
  fetchedAt: string
}

/** "https://www.retellai.com/careers" -> "retellai.com"; "https://jobs.bbc.co.uk" -> "bbc.co.uk"; null when it is not a public host. */
export function registrable(urlOrHost: string): string | null {
  let host: string
  try {
    host = new URL(urlOrHost.includes('://') ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
  const labels = host.split('.')
  if (labels.length < 2 || labels.some((l) => !l) || /^[\d.]+$/.test(host)) return null
  const keep = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/** The stored shape of a profile (company_directory.profile). */
export const toProfile = (w: WikidataEntity) => ({
  source: 'wikidata' as const,
  qid: w.qid,
  website: w.website,
  hq: w.hq,
  employees: w.employees,
  industry: w.industry,
  logo: w.logo,
  founded: w.founded,
  ticker: w.ticker,
  github: w.github,
  fetched_at: w.fetchedAt,
})

type Claims = Record<string, { rank?: string; mainsnak?: { datavalue?: { value?: unknown } }; qualifiers?: Record<string, { datavalue?: { value?: { time?: string } } }[]> }[]>
type Get = (params: Record<string, string>) => Promise<any>

const realGet: Get = async (params) => {
  const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: { 'user-agent': CELLO_USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`wikidata ${res.status}`)
  return res.json()
}

/** The value of a property: the preferred statement, else the newest dated one, else the last one listed. */
function valueOf(claims: Claims, prop: string): unknown {
  const list = (claims[prop] ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak?.datavalue?.value !== undefined)
  const pick = list.find((c) => c.rank === 'preferred') ?? [...list].sort((a, b) => (a.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? '').localeCompare(b.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? '')).pop()
  return pick?.mainsnak?.datavalue?.value
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idOf = (v: unknown) => (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null)

/**
 * Up to three organisations with this label that have an official website, with their facts. One search, one read of the
 * items and one read of the labels for headquarters and industry: three requests. Empty when nothing matches; throws when
 * Wikidata does not answer.
 */
export async function lookupWikidata(name: string, get: Get = realGet, now: () => number = Date.now): Promise<WikidataEntity[]> {
  const q = name.trim()
  if (!q) return []
  const found = await get({ action: 'wbsearchentities', search: q, language: 'en', type: 'item', limit: '3' })
  const hits = ((found?.search ?? []) as { id?: string; label?: string }[]).filter((h) => typeof h.id === 'string' && /^Q\d+$/.test(h.id))
  if (hits.length === 0) return []
  const items = (await get({ action: 'wbgetentities', ids: hits.map((h) => h.id).join('|'), props: 'claims|labels', languages: 'en' }))?.entities ?? {}

  const rows = hits.flatMap((h) => {
    const claims = (items[h.id as string]?.claims ?? {}) as Claims
    const website = text(valueOf(claims, 'P856'))
    return website && registrable(website) ? [{ h, claims, website }] : []
  })
  if (rows.length === 0) return []
  const labelIds = [...new Set(rows.flatMap((r) => [idOf(valueOf(r.claims, 'P159')), idOf(valueOf(r.claims, 'P452'))]).filter((x): x is string => !!x))]
  const labels = labelIds.length ? ((await get({ action: 'wbgetentities', ids: labelIds.join('|'), props: 'labels', languages: 'en' }))?.entities ?? {}) : {}
  const label = (id: string | null) => (id ? text(labels[id]?.labels?.en?.value) : null)

  const fetchedAt = new Date(now()).toISOString()
  return rows.map(({ h, claims, website }) => {
    const employees = Number(String((valueOf(claims, 'P1128') as { amount?: string } | undefined)?.amount ?? ''))
    const founded = Number(String((valueOf(claims, 'P571') as { time?: string } | undefined)?.time ?? '').slice(1, 5))
    const logoFile = text(valueOf(claims, 'P154'))
    return {
      qid: h.id as string,
      label: text(items[h.id as string]?.labels?.en?.value) ?? h.label ?? q,
      website,
      hq: label(idOf(valueOf(claims, 'P159'))),
      employees: Number.isFinite(employees) && employees > 0 ? employees : null,
      industry: label(idOf(valueOf(claims, 'P452'))),
      logo: logoFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(logoFile)}` : null,
      founded: Number.isInteger(founded) && founded > 0 ? founded : null,
      ticker: text(valueOf(claims, 'P249')),
      github: text(valueOf(claims, 'P2037')),
      fetchedAt,
    }
  })
}

/** One item by its Q-id, read from the record again: what an add stores, never what a client sent. */
export async function wikidataByQid(qid: string, get: Get = realGet, now: () => number = Date.now): Promise<WikidataEntity | null> {
  if (!/^Q\d+$/.test(qid)) return null
  const one = await lookupWikidata(qid, async (p) => (p.action === 'wbsearchentities' ? { search: [{ id: qid, label: qid }] } : get(p)), now)
  return one[0] ?? null
}
