// The declared step `role.type` (Roles plan 1.4, tier 2): a free model types the titles code could not.
//
// The answer is one role type id from the taxonomy, or `none`, and the words that decide it, quoted. The
// quote must be found in the title or in the first 600 characters of the posting, else the answer is `none`.
// A quote found in the title is about the title: it is written to the shared cache `title_types`, which
// serves every person. A quote found only in the posting is about that one posting: it is written to that
// `jobs` row only, and the shared cache records that the title alone decides nothing.
//
// The model runs through the ingest free-model call (lib/ingest/model.ts) and nowhere else; this file is the
// only one that calls the step. Provenance (lib/provenance/types.ts) is written with every answer.

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { parseJsonLoose } from '../harness/llm'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { MODEL_LIMIT, type ModelCall } from '../ingest/model'
import { ROLE_TYPE_IDS, TAXONOMY_VERSION } from '../jobs/role-types'
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
    maxTokens: 1800,
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

/** What apply_model_titles takes for one title. */
export function cacheRow(sample: Pick<Sample, 'title_norm' | 'dept_norm' | 'job_id'>, r: TypeResult): Record<string, unknown> {
  const shared = r.where === 'title'
  return {
    title_norm: sample.title_norm,
    dept_norm: sample.dept_norm,
    taxonomy_version: TAXONOMY_VERSION,
    // a title the posting had to explain decides nothing for other postings: the cache says none, this one role keeps its type
    role_type: shared ? r.type : null,
    status: shared ? 'typed' : 'none',
    prov: r.prov,
    ...(r.where === 'posting' ? { job_id: sample.job_id, job_type: r.type, job_prov: r.prov } : {}),
  }
}

/** Calls made today, from the spend ledger (one row for each model tried, so this can only overcount). */
async function callsToday(admin: Db, now: () => number): Promise<number> {
  const { count, error } = await admin.from('llm_spend').select('id', { count: 'exact', head: true }).eq('step', STEP).gte('created_at', new Date(now() - 86_400_000).toISOString())
  if (error) throw new Error('count_calls')
  return count ?? 0
}

/**
 * The step on the shared cache: pull titles code left pending (the most seen first, each with one open
 * untyped role to read), type them, write the answers. Serves the cache to every untyped role first and
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
  if (!call) return { ...out, stop: 'unavailable' }
  let left = Math.min(opts.maxCalls ?? SLICE_CALLS, DAILY_CALLS - (await callsToday(admin, opts.now)))
  if (left <= 0) return { ...out, stop: 'limit' }
  while (left > 0 && opts.now() < opts.deadlineAt) {
    const calls = Math.min(left, 4)
    const { data, error } = await admin.rpc('pending_title_samples', { p_limit: calls * BATCH })
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
