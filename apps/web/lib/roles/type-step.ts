// The declared step `role.type` (Roles plan 1.4, tier 2): a free model types the titles code could not.
//
// The answer is one role type id from the taxonomy, or `none`, and the words that decide it, quoted. The
// quote must be found in the title or in the first 600 characters of the posting, else the answer is `none`.
//
// What reaches the shared cache `title_types` (which serves every person) is only what the title alone decides:
// a quote found in the title of a title that names a job. A quote found only in the posting, and any answer
// for a title that names no particular job ("member of technical staff"), is about that one role: it is
// written to that `jobs` row only and the key stays `pending`, so the next role with that title is read too.
// Each role is read once (`jobs.type_read_at`), at most READS_PER_KEY roles of a key in a slice. A `none`
// from the title alone is cached, and expires when TAXONOMY_VERSION changes.
//
// The model runs through the ingest free-model call (lib/ingest/model.ts) and nowhere else; this file is the
// only one that calls the step. Provenance (lib/provenance/types.ts) is written with every answer.

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { parseJsonLoose } from '../harness/llm'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { MODEL_LIMIT, type ModelCall } from '../ingest/model'
import { AMBIGUOUS_TITLES, ROLE_TYPE_IDS, TAXONOMY_VERSION } from '../jobs/role-types'
import type { Prov } from '../provenance/types'
import { frameJobTextList } from '../security/job-text'

type Db = SupabaseClient<any, any, any>

export const STEP = 'role.type'
/** Titles a call types. */
export const BATCH = 25
/** Characters of the posting a call is shown. */
export const HEAD_CHARS = 600
/** Calls a slice of the clock may make. */
export const SLICE_CALLS = 40
/**
 * Calls the step may make in a day, counted from the spend ledger. The free account allows about 1,000 a day
 * for everything; this is a fifth of it. ponytail: a constant, an env value when the owner wants to tune it.
 */
export const DAILY_CALLS = 200
/** Roles of one key a slice may read (an ambiguous title is read role by role). */
export const READS_PER_KEY = 5

export interface TypeItem {
  i: number
  title: string
  department?: string | null
  /** The first HEAD_CHARS characters of the posting (jobs.description_md). */
  postingHead: string
}

export interface TypeResult {
  i: number
  /** A taxonomy id, or null for `none`. */
  type: string | null
  /** The quote that decided it, found in `where`; empty for `none`. */
  quote: string
  where: 'title' | 'posting' | null
  prov: Prov
}

export type TypeStop = 'limit' | 'unavailable' | null

const ItemSchema = z.object({ i: z.number().int(), type: z.enum(['none', ...ROLE_TYPE_IDS]), quote: z.string() })
const AnswerSchema = z.object({ items: z.array(z.unknown()) })

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function systemPrompt(): string {
  return composeSystemPrompt({ mode: loadModeDoc('role_type'), includeVoice: false })
}

export function userPrompt(items: TypeItem[]): string {
  const blocks = items.map((it) => ({
    id: String(it.i),
    text: `Title: ${it.title.trim().slice(0, 200)}\nDepartment: ${it.department?.trim().slice(0, 100) || 'not given'}\n\n${it.postingHead.slice(0, HEAD_CHARS)}`,
  }))
  return `Type these ${items.length} items.\n\n${frameJobTextList(blocks, { label: 'POSTING', maxChars: HEAD_CHARS + 400 })}`
}

/** One call for up to BATCH items. null when no model answered; MODEL_LIMIT when the allowance stopped it. */
export async function typeTitles(items: TypeItem[], call: ModelCall, now: () => Date = () => new Date()): Promise<TypeResult[] | typeof MODEL_LIMIT | null> {
  if (items.length === 0) return []
  if (items.length > BATCH) throw new Error('too many titles for one call')
  let model = ''
  const raw = await call({
    system: systemPrompt(),
    prompt: userPrompt(items),
    name: STEP,
    // json_object so a reasoning model answers with the object; room for 25 items (about 40 tokens each) plus any hidden reasoning
    json: true,
    maxTokens: 3000,
    promptRef: promptRef('role_type'),
    onModel: (m) => (model = m),
  })
  if (raw === MODEL_LIMIT) return MODEL_LIMIT
  if (!raw) return null
  let parsed: z.infer<typeof AnswerSchema>
  try {
    parsed = AnswerSchema.parse(parseJsonLoose(raw))
  } catch {
    return null
  }
  const answers = new Map<number, z.infer<typeof ItemSchema>>()
  for (const entry of parsed.items) {
    const a = ItemSchema.safeParse(entry)
    if (a.success && !answers.has(a.data.i)) answers.set(a.data.i, a.data)
  }
  const at = now().toISOString()
  return items.map((it) => {
    // an item the answer skips, or answers with a type the taxonomy lacks, is `none`: it was read and nothing decided it
    const a = answers.get(it.i)
    const quote = a ? fold(a.quote) : ''
    const where = a && a.type !== 'none' && quote.length >= 2 ? (fold(it.title).includes(quote) ? 'title' : fold(it.postingHead).includes(quote) ? 'posting' : null) : null
    const typed = a && where ? a.type : null
    return {
      i: it.i,
      type: typed,
      quote: typed ? a!.quote.trim() : '',
      where: typed ? where : null,
      prov: { step: STEP, model, rung: 'R3', evidence: typed ? [{ quote: a!.quote.trim() }] : [], at },
    }
  })
}

/** Any number of items in calls of BATCH; stops at the first call that got no answer. */
export async function typeBatches(items: TypeItem[], call: ModelCall, now?: () => Date): Promise<{ results: TypeResult[]; stop: TypeStop }> {
  const results: TypeResult[] = []
  for (let at = 0; at < items.length; at += BATCH) {
    const out = await typeTitles(items.slice(at, at + BATCH), call, now)
    if (out === MODEL_LIMIT) return { results, stop: 'limit' }
    if (!out) return { results, stop: 'unavailable' }
    results.push(...out)
  }
  return { results, stop: null }
}

interface Sample {
  title_norm: string
  dept_norm: string
  job_id: string
  title: string
  posting_head: string
}

/**
 * What apply_model_titles takes for one sampled role. The cache gets a typed answer only when the title alone
 * decided it, and a `none` only for a title that names a job. Otherwise the key stays `pending` and the role is
 * marked read (with its own type when the posting decided it).
 */
export function cacheRow(sample: Pick<Sample, 'title_norm' | 'dept_norm' | 'job_id'>, r: TypeResult): Record<string, unknown> {
  const base = { title_norm: sample.title_norm, dept_norm: sample.dept_norm, taxonomy_version: TAXONOMY_VERSION, prov: r.prov }
  const ambiguous = AMBIGUOUS_TITLES.includes(sample.title_norm)
  if (r.where === 'title' && !ambiguous) return { ...base, role_type: r.type, status: 'typed' }
  if (!r.type && !ambiguous) return { ...base, role_type: null, status: 'none' }
  return { ...base, role_type: null, status: 'pending', job_id: sample.job_id, read_at: r.prov.at, ...(r.type ? { job_type: r.type, job_prov: r.prov } : {}) }
}

/** Calls made today, from the spend ledger (one row for each model tried, so this can only overcount). */
async function callsToday(admin: Db, now: () => number): Promise<number> {
  const { count, error } = await admin.from('llm_spend').select('id', { count: 'exact', head: true }).eq('step', STEP).gte('created_at', new Date(now() - 86_400_000).toISOString())
  if (error) throw new Error('count_calls')
  return count ?? 0
}

/**
 * The step on the shared cache: pull the roles of titles still open (the most seen first, an ambiguous title
 * role by role), type them, write the answers. Serves the cache to every untyped role first and
 * last, so a title typed once reaches every role with it, new ones included.
 */
export async function runTypeStep(
  admin: Db,
  call: ModelCall | null,
  opts: { now: () => number; deadlineAt: number; maxCalls?: number }
): Promise<{ typed: number; none: number; stop: TypeStop }> {
  const apply = async (rows: Record<string, unknown>[]) => {
    const { error } = await admin.rpc('apply_model_titles', { p_rows: rows })
    if (error) throw new Error('apply_model_titles')
  }
  await apply([])
  const out = { typed: 0, none: 0, stop: null as TypeStop }
  const since = new Date(opts.now()).toISOString()
  if (!call) return { ...out, stop: 'unavailable' }
  let left = Math.min(opts.maxCalls ?? SLICE_CALLS, DAILY_CALLS - (await callsToday(admin, opts.now)))
  if (left <= 0) return { ...out, stop: 'limit' }
  while (left > 0 && opts.now() < opts.deadlineAt) {
    const calls = Math.min(left, 4)
    const { data, error } = await admin.rpc('pending_title_samples', { p_limit: calls * BATCH, p_version: TAXONOMY_VERSION, p_since: since, p_per_key: READS_PER_KEY, p_ambiguous: AMBIGUOUS_TITLES })
    if (error) throw new Error('pending_title_samples')
    const samples = (data ?? []) as Sample[]
    if (samples.length === 0) break
    const { results, stop } = await typeBatches(
      samples.map((s, i) => ({ i: i + 1, title: s.title, department: s.dept_norm, postingHead: s.posting_head })),
      call
    )
    left -= Math.ceil(samples.length / BATCH)
    const rows = results.map((r) => cacheRow(samples[r.i - 1], r))
    if (rows.length > 0) await apply(rows)
    for (const r of results) r.type ? out.typed++ : out.none++
    if (stop) return { ...out, stop }
  }
  return out
}
