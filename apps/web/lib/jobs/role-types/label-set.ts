// pnpm role-types:label-set: the 100 titles the owner marks by hand, which S2 scores tier 1 against.
//
//   write   100 titles from the owner's kept roles and application history, one for each distinct
//           normalised title, every type the owner holds first, to a CSV with the type Cello's code gave
//           and a blank column to mark
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
  tier1_type: string
  employer: string
  source: 'applied' | 'saved' | 'kept'
}

interface Held {
  id: string
  title: string
  title_norm: string | null
  role_type: string | null
  viewer_company_name: string | null
  saved_at: string | null
}

const SOURCE_RANK = { applied: 0, saved: 1, kept: 2 } as const

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

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function labelSetCsv(rows: LabelRow[]): string {
  const lines = ['title,title_norm,tier1_type,your_type,employer,source']
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

/** The marked rows: a row with `your_type` blank is not marked yet, and one with a type the taxonomy does not have is refused. */
export function parseLabelCsv(csv: string): { labelled: Labelled[]; refused: string[] } {
  const [header, ...rows] = csv.split(/\r?\n/).filter((l) => l.trim())
  const cols = cells(header ?? '')
  const at = (name: string) => cols.indexOf(name)
  const labelled: Labelled[] = []
  const refused: string[] = []
  for (const line of rows) {
    const c = cells(line)
    const type = (c[at('your_type')] ?? '').trim().toLowerCase()
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
