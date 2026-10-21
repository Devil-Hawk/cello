// pnpm role-types:label-set: the 100 titles the owner marks by hand, which S2 scores tier 1 against.
//
//   write   100 titles from the owner's kept roles and application history, one for each distinct
//           normalised title, every type the owner holds first, to a CSV with the type Cello gave (code or
//           the role.type step) and a blank `type` column to mark. When the owner holds fewer than 100, the
//           stratified sample of stored titles fills the rest (--file: at most 6 titles of a type, and 25 titles
//           tier 1 leaves untyped), and the first line of the file says whose data it is.
//   score   the marked CSV: per-type precision and recall, keep-recall over the chosen types, the 0.95 gate
//   import  the marked CSV as the Langfuse dataset `role-types` (input: the title; expected output: the type)
//
// Nothing here calls a model.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getRoleType } from './taxonomy'

type Db = SupabaseClient<any, any, any>

export const LABEL_SET_SIZE = 100
export const DATASET_NAME = 'role-types'

export interface LabelRow {
  title: string
  title_norm: string
  /** The type Cello gave the title, by code or by the model step; empty when it is untyped. */
  tier1_type: string
  employer: string
  source: 'applied' | 'saved' | 'kept' | 'common'
}

interface Held {
  id: string
  title: string
  title_norm: string | null
  role_type: string | null
  viewer_company_name: string | null
  saved_at: string | null
}

const SOURCE_RANK = { applied: 0, saved: 1, kept: 2, common: 3 } as const

/** Pure: one row for each distinct title_norm, taken round-robin across the types the owner holds, applied roles first in a type. */
export function chooseLabelRows(held: Held[], appliedJobIds: ReadonlySet<string>, limit = LABEL_SET_SIZE): LabelRow[] {
  const byTitle = new Map<string, LabelRow>()
  for (const h of held) {
    if (!h.title_norm) continue
    const source = appliedJobIds.has(h.id) ? 'applied' : h.saved_at ? 'saved' : 'kept'
    const row: LabelRow = { title: h.title, title_norm: h.title_norm, tier1_type: h.role_type ?? '', employer: h.viewer_company_name ?? '', source }
    const have = byTitle.get(h.title_norm)
    if (!have || SOURCE_RANK[source] < SOURCE_RANK[have.source]) byTitle.set(h.title_norm, row)
  }
  const groups = new Map<string, LabelRow[]>()
  for (const row of byTitle.values()) groups.set(row.tier1_type, [...(groups.get(row.tier1_type) ?? []), row])
  for (const rows of groups.values()) rows.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.title_norm.localeCompare(b.title_norm))
  // typed groups first, in the order the owner holds the most; the titles no rule typed last, so they still get marked
  const order = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b)))
  const out: LabelRow[] = []
  for (let i = 0; out.length < limit; i++) {
    let took = false
    for (const key of order) {
      const row = groups.get(key)![i]
      if (row && out.length < limit) {
        out.push(row)
        took = true
      }
    }
    if (!took) break
  }
  return out
}

export async function collectLabelRows(db: Db, userId: string, limit = LABEL_SET_SIZE): Promise<LabelRow[]> {
  const { data, error } = await db.from('person_jobs').select('id, title, title_norm, role_type, viewer_company_name, saved_at').eq('viewer_id', userId).limit(20_000)
  if (error) throw new Error('could not read the roles')
  const { data: apps, error: appsError } = await db.from('applications').select('job_id').eq('user_id', userId).limit(20_000)
  if (appsError) throw new Error('could not read the applications')
  return chooseLabelRows((data ?? []) as Held[], new Set(((apps ?? []) as { job_id: string }[]).map((a) => a.job_id)), limit)
}

/** Most titles of one type the file takes, so no type fills the 100, and the titles tier 1 left untyped it adds. */
export const PER_TYPE_CAP = 6
export const UNTYPED_EXTRA = 25

interface Stored {
  title: string
  title_norm: string
  role_type: string | null
  type_origin?: string | null
}

/**
 * Pure. `typedLimit` titles that tier 1 (code) typed, round-robin across the types, the most common titles of
 * a type first and at most PER_TYPE_CAP of a type; then `untypedLimit` of the most common titles it left
 * untyped. One row for each distinct title_norm, none that is in `have`.
 */
export function stratifiedTitles(stored: Stored[], have: ReadonlySet<string>, typedLimit: number, untypedLimit = UNTYPED_EXTRA): LabelRow[] {
  const seen = new Map<string, { row: LabelRow; n: number }>()
  for (const j of stored) {
    if (!j.title_norm || have.has(j.title_norm) || j.type_origin === 'model') continue
    const at = seen.get(j.title_norm)
    if (at) at.n++
    else seen.set(j.title_norm, { n: 1, row: { title: j.title, title_norm: j.title_norm, tier1_type: j.role_type ?? '', employer: '', source: 'common' } })
  }
  const byType = new Map<string, { row: LabelRow; n: number }[]>()
  for (const s of seen.values()) byType.set(s.row.tier1_type, [...(byType.get(s.row.tier1_type) ?? []), s])
  for (const list of byType.values()) list.sort((a, b) => b.n - a.n || a.row.title_norm.localeCompare(b.row.title_norm))
  const untyped = (byType.get('') ?? []).slice(0, untypedLimit).map((s) => s.row)
  byType.delete('')
  const order = [...byType.keys()].sort((a, b) => byType.get(b)!.length - byType.get(a)!.length || a.localeCompare(b))
  const typed: LabelRow[] = []
  for (let i = 0; i < PER_TYPE_CAP && typed.length < typedLimit; i++) {
    for (const type of order) {
      const s = byType.get(type)![i]
      if (s && typed.length < typedLimit) typed.push(s.row)
    }
  }
  return [...typed, ...untyped]
}

/** A sample of stored roles that are not in `have`, for a set the owner's own roles do not fill. */
export async function commonTitles(db: Db, have: ReadonlySet<string>, limit: number): Promise<LabelRow[]> {
  const { data, error } = await db.from('jobs').select('title, title_norm, role_type, type_origin').not('title_norm', 'is', null).neq('title_norm', '').limit(50_000)
  if (error) throw new Error('could not read the stored roles')
  return stratifiedTitles((data ?? []) as Stored[], have, limit)
}

/** The owner's own roles first (when there is an owner), then a stratified sample of stored titles for the rest. */
export async function collectFileRows(db: Db, userId: string | null, limit = LABEL_SET_SIZE): Promise<LabelRow[]> {
  const own = userId ? await collectLabelRows(db, userId, limit) : []
  if (own.length >= limit) return own
  return [...own, ...(await commonTitles(db, new Set(own.map((r) => r.title_norm)), limit - own.length))]
}

/** The first line of the file: whose data it is. A line beginning with # is skipped when the file is read back. */
export function fileNote(rows: LabelRow[]): string {
  return rows.some((r) => r.source !== 'common')
    ? "# the owner's applied, saved and kept roles first, then a public boards sample for the rest (source common); the sample is not the owner's roles"
    : "# public boards sample, not the owner's roles; rerun with --owner on the owner's database"
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function labelSetCsv(rows: LabelRow[], note?: string): string {
  const lines = [...(note ? [note] : []), 'title,title_norm,cello_type,type,employer,source']
  for (const r of rows) lines.push([r.title, r.title_norm, r.tier1_type, '', r.employer, r.source].map(cell).join(','))
  return lines.join('\n') + '\n'
}

/** Split one CSV line, honouring quotes. */
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

export interface Labelled {
  title: string
  title_norm: string
  /** A role type id, or 'none' for a title the owner says fits no type. */
  role_type: string
}

/** The marked rows: a row with `type` blank is not marked yet, and one with a type the taxonomy does not have is refused. */
export function parseLabelCsv(csv: string): { labelled: Labelled[]; refused: string[] } {
  const [header, ...rows] = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
  const cols = cells(header ?? '')
  const at = (name: string) => cols.indexOf(name)
  // the column to mark was once called your_type
  const typeAt = at('type') >= 0 ? at('type') : at('your_type')
  const labelled: Labelled[] = []
  const refused: string[] = []
  for (const line of rows) {
    const c = cells(line)
    const type = (c[typeAt] ?? '').trim().toLowerCase()
    if (!type) continue
    const title = c[at('title')] ?? ''
    if (type !== 'none' && (!getRoleType(type) || type === 'other')) {
      refused.push(`${title}: ${type}`)
      continue
    }
    labelled.push({ title, title_norm: c[at('title_norm')] ?? '', role_type: type })
  }
  return { labelled, refused }
}

export interface TypeScore {
  type: string
  labels: number
  precision: number | null
  recall: number | null
}

export interface LabelScore {
  perType: TypeScore[]
  /** Share of the owner's roles of a chosen type that Cello also gave a chosen type; null when there are none. */
  keepRecall: number | null
  keepN: number
  gate: boolean | null
}

export const MIN_LABELS = 10
export const TYPE_BAR = 0.9
export const KEEP_BAR = 0.95

const share = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null)

/**
 * Pure. `rows` are the marked rows: what Cello gave ('' for untyped) and what the owner says. A type with fewer
 * than MIN_LABELS labels is reported with no numbers ("Too few to tell"). `chosen` are the owner's types; null
 * means every type they labelled. The gate is keep-recall at least KEEP_BAR.
 */
export function scoreLabels(rows: { cello: string; label: string }[], chosen: readonly string[] | null): LabelScore {
  const types = [...new Set(rows.map((r) => r.label).filter((l) => l !== 'none'))].sort()
  const perType = types.map((type) => {
    const labels = rows.filter((r) => r.label === type).length
    if (labels < MIN_LABELS) return { type, labels, precision: null, recall: null }
    const hit = rows.filter((r) => r.label === type && r.cello === type).length
    return { type, labels, precision: share(hit, rows.filter((r) => r.cello === type).length), recall: share(hit, labels) }
  })
  const mine = new Set(chosen ?? types)
  const wanted = rows.filter((r) => mine.has(r.label))
  const kept = wanted.filter((r) => mine.has(r.cello)).length
  const keepRecall = share(kept, wanted.length)
  return { perType, keepRecall, keepN: wanted.length, gate: keepRecall === null ? null : keepRecall >= KEEP_BAR }
}

export function scoreReport(score: LabelScore, chosenGiven: boolean): string[] {
  const out = score.perType.map((t) =>
    t.precision === null && t.recall === null
      ? `${t.type}: labels ${t.labels}. Too few to tell`
      : `${t.type}: labels ${t.labels}, precision ${t.precision ?? 'not known'}, recall ${t.recall ?? 'not known'}${(t.precision ?? 0) >= TYPE_BAR && (t.recall ?? 0) >= TYPE_BAR ? '' : ' (under 0.90)'}`
  )
  out.push(
    score.keepRecall === null
      ? 'Keep-recall: none of the marked titles is one of the chosen types, so it cannot be read yet'
      : `Keep-recall over ${chosenGiven ? 'your chosen types' : 'every type you marked (pass --chosen to narrow it)'}: ${score.keepRecall} on ${score.keepN} titles`
  )
  out.push(score.gate === null ? 'The 0.95 gate cannot be read yet' : score.gate ? 'The 0.95 gate holds' : 'The 0.95 gate does not hold')
  return out
}

/** The CSV a person marked: what Cello gave and what they say, for the rows they marked. Reads the old column names too. */
export function parseScoredRows(csv: string): { cello: string; label: string }[] {
  const [header, ...rows] = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
  const cols = cells(header ?? '')
  const find = (...names: string[]) => names.map((n) => cols.indexOf(n)).find((i) => i >= 0) ?? -1
  const celloAt = find('cello_type', 'tier1_type')
  const typeAt = find('type', 'your_type')
  return rows
    .map(cells)
    .map((c) => ({ cello: (c[celloAt] ?? '').trim().toLowerCase(), label: (c[typeAt] ?? '').trim().toLowerCase() }))
    .filter((r) => r.label)
}

/** Create the dataset and one item for each marked title; the same title again updates its item. */
export async function importLabelSet(
  labelled: Labelled[],
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<{ imported: number }> {
  const base = env.LANGFUSE_BASE_URL?.replace(/\/$/, '')
  const pub = env.LANGFUSE_PUBLIC_KEY
  const secret = env.LANGFUSE_SECRET_KEY
  if (!base || !pub || !secret) throw new Error('set LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY')
  const headers = { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${pub}:${secret}`).toString('base64')}` }
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`Langfuse ${path} answered ${res.status}`)
  }
  await post('/api/public/datasets', { name: DATASET_NAME, description: "The owner's marked titles: S2 scores tier 1 against them" })
  for (const l of labelled) {
    await post('/api/public/dataset-items', {
      datasetName: DATASET_NAME,
      id: `${DATASET_NAME}:${l.title_norm || l.title}`.slice(0, 200),
      input: { title: l.title, title_norm: l.title_norm },
      expectedOutput: { role_type: l.role_type },
    })
  }
  return { imported: labelled.length }
}
