// The person's screening answers. Stored once, matched by exact key or a guarded similarity match,
// never produced by a model: a value comes from the profile, from the two work facts, or from a row
// the person saved. A question with no value is one open row, however many applications ask it; the
// person answers it once and every application waiting on it moves on.
//
// Pass the service-role client; every function filters on user_id itself.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildApplyProfile, type ApplyProfile } from '@/lib/ats-apply'
import { DOORS } from '@/lib/pipeline/actors'
import { note, transition } from '@/lib/pipeline/transition'
import { categorize, isSensitive, isSpecific, workAuthAnswer, type Category, type FieldKind, type WorkFacts } from './categories'
import { findAnswer, type Asked, type BankRow, type Scope } from './match'
import { neverFilled, personOnly } from './never'
import { normalizeQuestion } from './normalize'

export { normalizeQuestion } from './normalize'

const COLUMNS = 'id, question, question_key, category, sensitive, specific, kind, options, answer, declined, company_id, source, source_ref, origin, confirmed_at, updated_at'

/** The map of a bank row's source to its one-word origin (blueprint 3.2). Confirm never changes it. */
export const ORIGIN_OF = { person: 'person', profile: 'person', resume: 'code', approved_draft: 'model', chat: 'model' } as const

export interface FormField {
  id: string
  label: string
  kind?: FieldKind
  options?: string[]
  required?: boolean
}

export interface Resolved {
  value: unknown
  /** Where it came from: the profile, a work fact, or a saved answer (exact or similar). */
  via: 'profile' | 'fact' | 'exact' | 'similar'
  origin: 'person' | 'code' | 'model'
  answerId?: string
  /** For "Used your saved answer to '...'" in the tab. */
  usedQuestion?: string
}

export interface OpenQuestion {
  fieldId: string
  answerId: string
  question: string
}

export interface FieldValues {
  values: Record<string, Resolved>
  /** Required fields with no value Cello may give: one open row each, for the person to answer. */
  open: OpenQuestion[]
  /** Field ids Cello leaves blank on every form: demographics and consents. */
  never: string[]
}

export interface JobScope extends Scope {
  companyName: string | null
}

const FACT_AUTH = 'fact:work_authorized'
const FACT_SPONSOR = 'fact:needs_sponsorship'

export function classify(field: FormField, companyName: string | null = null): Asked & { category: Category } {
  const category = categorize(field.label)
  const mentionsCompany = Boolean(companyName && field.label.toLowerCase().includes(companyName.toLowerCase()))
  return {
    key: normalizeQuestion(field.label),
    category,
    sensitive: isSensitive(category),
    // a question that names the employer is specific to it
    specific: isSpecific(field.label) || mentionsCompany,
    kind: field.kind ?? (field.options?.length ? 'select' : 'text'),
    options: field.options?.length ? field.options : null,
  }
}

async function rowsOf(admin: SupabaseClient, userId: string): Promise<BankRow[]> {
  const { data, error } = await admin.from('answer_bank').select(COLUMNS).eq('user_id', userId).limit(2000)
  if (error) throw new Error(`answer_bank read failed: ${error.message}`)
  return (data ?? []) as BankRow[]
}

const workFactsOf = (rows: readonly BankRow[]): WorkFacts => {
  const get = (k: string) => (rows.find((r) => r.source === 'profile' && r.question_key === k && typeof r.answer === 'boolean')?.answer as boolean | undefined) ?? null
  return { authorized: get(FACT_AUTH), needsSponsorship: get(FACT_SPONSOR) }
}

export async function workFacts(admin: SupabaseClient, userId: string): Promise<WorkFacts> {
  return workFactsOf(await rowsOf(admin, userId))
}

/** A yes or no for a field: the option that reads Yes or No when the form lists options. */
function yesNo(v: boolean, options: string[] | null): unknown {
  if (!options) return v
  return options.find((o) => (v ? /^yes\b/i : /^no\b/i).test(o.trim())) ?? null
}

function profileValue(label: string, p: ApplyProfile): string | null {
  const l = label.toLowerCase()
  if (/\bfirst name|given name|preferred name\b/.test(l)) return p.firstName || null
  if (/\blast name|surname|family name\b/.test(l)) return p.lastName || null
  if (/\b(full|legal) name|^name\b|your name/.test(l)) return p.fullName || null
  if (/\be-?mail\b/.test(l)) return p.email || null
  if (/\b(phone|mobile|telephone)\b/.test(l)) return p.phone ?? null
  if (/linkedin/.test(l)) return p.linkedin ?? null
  if (/website|portfolio|personal site/.test(l)) return p.website ?? null
  if (/current (city|location)|where are you (located|based)|^location\b/.test(l)) return p.location ?? null
  return null
}

/**
 * Values for the fields a form asks, in the order of trust: the profile, the person's work facts, a
 * saved answer by exact key, a saved answer by guarded similarity. Values only for the fields asked.
 * What is left and required becomes one open row per question.
 */
export async function resolveFieldValues(
  admin: SupabaseClient,
  userId: string,
  fields: readonly FormField[],
  job: JobScope,
): Promise<FieldValues> {
  const [rows, profileRow] = await Promise.all([
    rowsOf(admin, userId),
    admin.from('profiles').select('full_name, email, preferences, resume_text').eq('id', userId).maybeSingle(),
  ])
  const facts = workFactsOf(rows)
  const profile = buildApplyProfile((profileRow.data ?? {}) as Parameters<typeof buildApplyProfile>[0])

  const out: FieldValues = { values: {}, open: [], never: [] }
  for (const f of fields) {
    const asked = classify(f, job.companyName)
    if (neverFilled(asked.category)) {
      out.never.push(f.id)
      continue
    }

    if (asked.category === 'contact' || asked.category === 'links' || asked.category === 'location') {
      const v = profileValue(f.label, profile)
      if (v) {
        out.values[f.id] = { value: v, via: 'profile', origin: 'person' }
        continue
      }
    }

    if (asked.category === 'work_auth' || asked.category === 'sponsorship') {
      const yn = workAuthAnswer(f.label, facts)
      const v = yn === null ? null : yesNo(yn, asked.options)
      if (v !== null) {
        out.values[f.id] = { value: v, via: 'fact', origin: 'person' }
        continue
      }
    }

    const hit = findAnswer(rows, personOnly(f.label, asked.category) ? { ...asked, specific: true } : asked, job)
    if (hit && valueFits(hit.row.answer, asked.options)) {
      out.values[f.id] = { value: hit.row.answer, via: hit.via, origin: hit.row.origin, answerId: hit.row.id, usedQuestion: hit.via === 'similar' ? hit.row.question : undefined }
      continue
    }

    if (f.required) {
      const id = await openRow(admin, userId, f, asked, job)
      if (id) out.open.push({ fieldId: f.id, answerId: id, question: f.label })
    }
  }
  return out
}

/** A select's saved answer must be exactly one of the options the form shows. */
function valueFits(answer: unknown, options: string[] | null): boolean {
  if (!options) return true
  return typeof answer === 'string' && options.some((o) => o.trim().toLowerCase() === answer.trim().toLowerCase())
}

/** One open row per question and employer scope, however many applications ask it. */
async function openRow(admin: SupabaseClient, userId: string, f: FormField, asked: Asked & { category: Category }, job: JobScope): Promise<string | null> {
  const companyId = asked.specific && job.companyName && f.label.toLowerCase().includes(job.companyName.toLowerCase()) ? job.companyId : null
  const base = { user_id: userId, question: f.label.slice(0, 500), question_key: asked.key, category: asked.category, sensitive: asked.sensitive, specific: asked.specific, kind: asked.kind, options: asked.options, company_id: companyId, source: 'person', origin: 'person', source_ref: job.applicationId ? { application_id: job.applicationId } : null }
  const ins = await admin.from('answer_bank').insert(base).select('id').maybeSingle()
  if (ins.data) return (ins.data as { id: string }).id
  // 23505: the row exists already (another application asked first)
  let q = admin.from('answer_bank').select('id').eq('user_id', userId).eq('question_key', asked.key)
  q = companyId ? q.eq('company_id', companyId) : q.is('company_id', null)
  const have = await q.maybeSingle()
  return (have.data as { id: string } | null)?.id ?? null
}

// ---------------------------------------------------------------------------
// Writing answers
// ---------------------------------------------------------------------------

export type SaveResult = { ok: true; id: string } | { ok: false; sentence: string }

/** The person's answer to one row: source person, so Send for me may use it. */
export async function saveAnswer(admin: SupabaseClient, userId: string, id: string, input: { answer?: unknown; declined?: boolean }): Promise<SaveResult> {
  if (input.answer === undefined && input.declined === undefined) return { ok: false, sentence: 'Say what to save.' }
  const answer = input.answer
  if (answer !== undefined && answer !== null) {
    const size = JSON.stringify(answer).length
    if (size > 4000) return { ok: false, sentence: 'That answer is too long. Keep it under 4,000 characters.' }
  }
  const patch: Record<string, unknown> = { source: 'person', origin: 'person', prov: { door: 'session' }, confirmed_at: null, updated_at: new Date().toISOString() }
  if (answer !== undefined) {
    patch.answer = answer
    patch.declined = false
  }
  if (input.declined !== undefined) patch.declined = input.declined
  const { data } = await admin.from('answer_bank').update(patch).eq('id', id).eq('user_id', userId).select('id').maybeSingle()
  return data ? { ok: true, id } : { ok: false, sentence: 'That question is gone.' }
}

/** The person accepts a model's answer. It keeps origin model: Send for me still does not use it. */
export async function confirmAnswer(admin: SupabaseClient, userId: string, id: string): Promise<SaveResult> {
  const { data } = await admin
    .from('answer_bank')
    .update({ confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .eq('origin', 'model')
    .not('answer', 'is', null)
    .select('id')
    .maybeSingle()
  return data ? { ok: true, id } : { ok: false, sentence: 'There is no saved answer to confirm.' }
}

/** The two facts the person gives once; code maps the wordings it knows to them. */
export async function saveWorkFacts(admin: SupabaseClient, userId: string, f: { authorized: boolean; needsSponsorship: boolean }): Promise<SaveResult> {
  for (const [key, question, category, answer] of [
    [FACT_AUTH, 'Are you authorized to work?', 'work_auth', f.authorized],
    [FACT_SPONSOR, 'Will you need sponsorship?', 'sponsorship', f.needsSponsorship],
  ] as const) {
    const { data: have } = await admin.from('answer_bank').select('id').eq('user_id', userId).eq('question_key', key).is('company_id', null).maybeSingle()
    const row = { answer, declined: false, source: 'profile', origin: 'person', prov: { door: 'session' }, updated_at: new Date().toISOString() }
    const r = have
      ? await admin.from('answer_bank').update(row).eq('id', (have as { id: string }).id).eq('user_id', userId)
      : await admin.from('answer_bank').insert({ ...row, user_id: userId, question, question_key: key, category, sensitive: true, specific: false, kind: 'yes_no' })
    if (r.error) return { ok: false, sentence: 'Could not save that. Try again.' }
  }
  return { ok: true, id: FACT_AUTH }
}

/**
 * "Save these answers for next time", ticked one by one on what was sent. Sensitive questions and
 * consents are never offered and never saved here. A long answer keeps the application it came from.
 */
export async function saveFromAttempt(
  admin: SupabaseClient,
  userId: string,
  from: { applicationId: string | null; attemptId: string; companyId: string | null; companyName: string | null },
  items: readonly { question: string; answer: unknown; kind?: FieldKind; options?: string[] }[],
): Promise<{ saved: number; skipped: number }> {
  let saved = 0
  let skipped = 0
  for (const it of items.slice(0, 50)) {
    const label = String(it.question ?? '').slice(0, 500)
    const asked = classify({ id: label, label, kind: it.kind, options: it.options }, from.companyName)
    const empty = it.answer === null || it.answer === undefined || it.answer === ''
    if (!label || empty || asked.sensitive || JSON.stringify(it.answer).length > 4000) {
      skipped++
      continue
    }
    const companyId = from.companyName && label.toLowerCase().includes(from.companyName.toLowerCase()) ? from.companyId : null
    let q = admin.from('answer_bank').select('id').eq('user_id', userId).eq('question_key', asked.key)
    q = companyId ? q.eq('company_id', companyId) : q.is('company_id', null)
    const have = ((await q.maybeSingle()).data as { id: string } | null)?.id
    const ref = { application_id: from.applicationId, attempt_id: from.attemptId }
    const fields = { answer: it.answer, declined: false, source: 'person', origin: 'person', source_ref: ref, prov: { door: 'session' }, confirmed_at: null, updated_at: new Date().toISOString() }
    const r = have
      ? await admin.from('answer_bank').update(fields).eq('id', have).eq('user_id', userId)
      : await admin.from('answer_bank').insert({ ...fields, user_id: userId, question: label, question_key: asked.key, category: asked.category, sensitive: false, specific: asked.specific, kind: asked.kind, options: asked.options, company_id: companyId })
    if (r.error) skipped++
    else saved++
  }
  return { saved, skipped }
}

/**
 * Something the person said in Chat, saved as a proposal. It moves no application and Send for me never
 * uses it: the person's Confirm (confirmAnswer) is what makes it usable in their own Fill.
 */
export async function proposeFromChat(
  admin: SupabaseClient,
  userId: string,
  input: { answerId: string; answer: unknown; quote: string; conversationId?: string },
): Promise<SaveResult> {
  const { data: row } = await admin.from('answer_bank').select('id, category, answer').eq('id', input.answerId).eq('user_id', userId).maybeSingle()
  const r = row as { id: string; category: Category; answer: unknown } | null
  if (!r) return { ok: false, sentence: 'That question is gone.' }
  if (isSensitive(r.category)) return { ok: false, sentence: 'Answer this one yourself on the Answers page. Cello does not take it from a chat.' }
  const { error } = await admin
    .from('answer_bank')
    .update({ answer: input.answer, source: 'chat', origin: 'model', source_ref: { conversation_id: input.conversationId ?? null, quote: input.quote.slice(0, 300) }, prov: { step: 'chat', door: DOORS.chat.channel, evidence: input.quote.slice(0, 300), at: new Date().toISOString() }, confirmed_at: null, updated_at: new Date().toISOString() })
    .eq('id', input.answerId)
    .eq('user_id', userId)
  if (error) return { ok: false, sentence: 'Could not save that. Try again.' }
  // a line for the timeline; it moves nothing
  await note(admin, userId, null, {
    kind: 'question.answered',
    actor: DOORS.chat.actor,
    channel: DOORS.chat.channel,
    sentence: 'Cello saved an answer from what you said in Chat. Confirm it to use it.',
    idempotencyKey: `chat-answer:${input.answerId}:${Date.now()}`,
    trust: 'unconfirmed',
    origin: 'model',
  }).catch(() => undefined)
  return { ok: true, id: input.answerId }
}

/**
 * The port the pipeline calls when an answer arrives: each application waiting on it (and on nothing else
 * open) moves from Needs you to Preparing, as the person's move.
 */
export async function answerArrived(admin: SupabaseClient, userId: string, answerId: string): Promise<{ moved: number }> {
  const { data: waiting } = await admin
    .from('applications')
    .select('id, needs_detail, last_event_at')
    .eq('user_id', userId)
    .eq('state', 'needs_you')
    .eq('needs_reason', 'answer')
    .contains('needs_detail', { answer_ids: [answerId] })
  let moved = 0
  for (const a of (waiting ?? []) as { id: string; needs_detail: { answer_ids: string[] }; last_event_at: string | null }[]) {
    const { data: asked } = await admin.from('answer_bank').select('id, answer, declined').eq('user_id', userId).in('id', a.needs_detail.answer_ids)
    const stillOpen = ((asked ?? []) as { answer: unknown; declined: boolean }[]).some((r) => r.answer === null && !r.declined)
    if (stillOpen) continue
    const r = await transition(admin, {
      applicationId: a.id,
      from: ['needs_you'],
      to: 'preparing',
      step: 'Continuing with your answer',
      event: {
        kind: 'question.answered',
        actor: DOORS.session.actor,
        channel: DOORS.session.channel,
        sentence: 'You answered a question. Cello is carrying on.',
        idempotencyKey: `answered:${a.id}:${answerId}:${a.last_event_at ?? 'none'}`,
        payload: { answer_id: answerId },
      },
    })
    if (r.ok) moved++
  }
  return { moved }
}
