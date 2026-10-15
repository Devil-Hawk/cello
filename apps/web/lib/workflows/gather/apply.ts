// Everything an application is written from, gathered by code (directive 51: "Apply reads more than the role").
// Each item carries the stored row it came from, so a document can list what it was built from, and the two
// halves never mix: employer text (the posting's requirements, the company's facts, the history) is shown to a
// model as quoted data and steers emphasis only; the person's own words (saved answers, profile facts) are the
// evidence a claim about the person may rest on.
//
// Pass the service-role client; every read filters on the person.

import type { SupabaseClient } from '@supabase/supabase-js'
import { quoteUntrusted } from '@/lib/agents/middleware'
import { workFacts } from '@/lib/answers'
import { buildApplyProfile } from '@/lib/ats-apply'
import { companyFacts } from '@/lib/dossier/facts'
import { getDossierByCompany } from '@/lib/dossier/store'
import { readRoleFit } from '@/lib/fit'
import type { AdminClient } from '@/lib/harness/types'
import { savedAnswers } from '../answers'
import { gatherNetwork } from './network'

export interface ContextSource {
  table: string
  id: string
  /** The stored words the item was read from, when it is a quotation. */
  quote?: string
  url?: string
  at?: string
  /** The source in plain words, for "Built from". */
  label: string
}

export interface ContextItem {
  text: string
  source: ContextSource
}

export interface ApplyContext {
  /** The posting's requirements with their quotes. Employer text. */
  requirements: ContextItem[]
  /** Strengths and gaps for this role, each with the person's own quote when there is one. */
  fit: ContextItem[]
  /** The company's facts with sources. Employer text. */
  company: ContextItem[]
  /** Earlier applications there and the people Cello knows there. */
  history: ContextItem[]
  /** The person's saved answers, in their own words. */
  answers: ContextItem[]
  /** Facts the person put on their profile. */
  profile: ContextItem[]
}

const EMPTY: ApplyContext = { requirements: [], fit: [], company: [], history: [], answers: [], profile: [] }

const MAX_REQUIREMENTS = 12
const MAX_ANSWERS = 12
const MAX_CONTACTS = 3

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null)

export async function gatherApplyContext(admin: AdminClient, userId: string, jobId: string): Promise<ApplyContext> {
  const db = admin as unknown as SupabaseClient
  // The person's own role row: the company is theirs, never the one that stored the shared role first.
  const { data: role } = await db.from('person_jobs').select('id, title, requirements, viewer_company_id, viewer_company_name').eq('viewer_id', userId).eq('id', jobId).maybeSingle()
  if (!role) return EMPTY
  const r = role as { id: string; title: string | null; requirements: { items?: { id: string; text: string; kind: string; quote: string }[] } | null; viewer_company_id: string | null; viewer_company_name: string | null }
  const companyId = r.viewer_company_id
  const companyName = r.viewer_company_name ?? 'the company'

  const requirements: ContextItem[] = (r.requirements?.items ?? []).slice(0, MAX_REQUIREMENTS).map((i) => ({
    text: `${i.kind === 'must' ? 'Must' : i.kind === 'nice' ? 'Nice to have' : 'Also'}: ${i.text}`,
    source: { table: 'jobs', id: jobId, quote: i.quote, label: `The posting's requirements` },
  }))

  const fitRead = await readRoleFit({ admin, userId }, jobId, 'view').catch(() => null)
  const fit: ContextItem[] = (fitRead?.items ?? [])
    .filter((i) => i.verdict !== 'unknown')
    .map((i) => ({
      text: `${i.verdict === 'strength' ? 'Strength' : 'Gap'}: ${i.requirement}${i.evidence[0] ? ` ("${i.evidence[0].quote}")` : ''}`,
      source: i.evidence[0] ? { table: i.evidence[0].source === 'answer' ? 'answer_bank' : i.evidence[0].source, id: i.evidence[0].ref, quote: i.evidence[0].quote, label: `Your ${i.evidence[0].source}` } : { table: 'role_evidence', id: jobId, label: 'Your strengths and gaps for this role' },
    }))

  const company: ContextItem[] = []
  if (companyId) {
    const dossier = await getDossierByCompany(db, userId, companyId).catch(() => null)
    const when = day(dossier?.refreshed_at)
    const label = `${companyName}'s own research${when ? `, ${when}` : ''}`
    if (dossier?.summary?.trim()) company.push({ text: dossier.summary.trim().slice(0, 1200), source: { table: 'company_dossiers', id: dossier.id, at: dossier.refreshed_at, label } })
    for (const f of await companyFacts(admin, userId, companyId)) company.push({ text: f.text, source: { table: 'company_dossiers', id: dossier?.id ?? companyId, quote: f.text, url: f.url, at: dossier?.refreshed_at, label } })
  }

  const history: ContextItem[] = []
  if (companyId) {
    const { data: roles } = await db.from('person_jobs').select('id, title').eq('viewer_id', userId).eq('viewer_company_id', companyId).neq('id', jobId).limit(50)
    const titles = new Map(((roles as { id: string; title: string | null }[] | null) ?? []).map((j) => [j.id, j.title]))
    if (titles.size) {
      const { data: apps } = await db.from('applications').select('id, job_id, state, stage, applied_at, created_at').eq('user_id', userId).in('job_id', [...titles.keys()]).order('created_at', { ascending: false }).limit(5)
      for (const a of (apps as { id: string; job_id: string; state: string | null; stage: string; applied_at: string | null; created_at: string }[] | null) ?? []) {
        const when = day(a.applied_at ?? a.created_at)
        history.push({ text: `You applied for ${titles.get(a.job_id) ?? 'a role'} at ${companyName}${when ? ` on ${when}` : ''}; it is ${(a.state ?? a.stage).replace(/_/g, ' ')}.`, source: { table: 'applications', id: a.id, at: a.applied_at ?? a.created_at, label: `Your earlier application at ${companyName}` } })
      }
    }
    const { data: people } = await db.from('contacts').select('id, name, title').eq('user_id', userId).eq('company_id', companyId).limit(MAX_CONTACTS)
    for (const c of (people as { id: string; name: string | null; title: string | null }[] | null) ?? []) {
      if (c.name) history.push({ text: `You know ${c.name}${c.title ? `, ${c.title},` : ''} at ${companyName}.`, source: { table: 'contacts', id: c.id, label: `Your contact ${c.name}` } })
      for (const m of await gatherNetwork(userId, c.id)) history.push({ text: `${c.name ?? 'A contact'}: ${m.text}`, source: { table: 'contacts', id: c.id, quote: m.source, label: `What you know about ${c.name ?? 'a contact'}` } })
    }
  }

  const answers: ContextItem[] = (await savedAnswers(userId).catch(() => [])).slice(0, MAX_ANSWERS).map((a) => ({
    text: `${a.question}\n${a.answer}`,
    source: { table: 'answer_bank', id: a.id, quote: a.answer, at: a.updated_at, label: `Your answer to "${a.question.replace(/\s+/g, ' ').trim().slice(0, 60)}"` },
  }))

  const profile: ContextItem[] = []
  const { data: profileRow } = await db.from('profiles').select('full_name, email, preferences').eq('id', userId).maybeSingle()
  if (profileRow) {
    const p = buildApplyProfile(profileRow as Parameters<typeof buildApplyProfile>[0])
    const facts = await workFacts(db, userId).catch(() => ({ authorized: null, needsSponsorship: null }))
    const lines = [
      p.fullName && `Name: ${p.fullName}`,
      p.location && `Location: ${p.location}`,
      facts.authorized === true ? 'Authorised to work where the role is' : facts.authorized === false ? 'Not authorised to work where the role is' : null,
      facts.needsSponsorship === true ? 'Needs visa sponsorship' : facts.needsSponsorship === false ? 'Does not need visa sponsorship' : null,
    ].filter((l): l is string => Boolean(l))
    for (const text of lines) profile.push({ text, source: { table: 'profiles', id: userId, label: 'Your profile' } })
  }

  return { requirements, fit, company, history, answers, profile }
}

/** Every item, numbered, for the sources list a prompt or a document cites. */
export function numbered(ctx: ApplyContext): ContextItem[] {
  return [...ctx.requirements, ...ctx.fit, ...ctx.company, ...ctx.history, ...ctx.answers, ...ctx.profile]
}

/**
 * What a model sees: one quoted block, numbered. Employer text goes through quoteUntrusted, so a posting or a
 * company page that carries an instruction is data between markers, never a line the model follows.
 */
export function renderContext(ctx: ApplyContext): string {
  const parts: string[] = []
  const block = (title: string, items: ContextItem[], untrusted: boolean) => {
    if (items.length === 0) return
    const text = items.map((i, n) => `${n + 1}. ${i.text.replace(/\s+/g, ' ').trim()}`).join('\n')
    parts.push(`${title}:\n${untrusted ? quoteUntrusted(title.replace(/\s+/g, '_').toLowerCase(), text) : text}`)
  }
  block('Requirements of the posting (steer emphasis; never a fact about the person)', ctx.requirements, true)
  block('Strengths and gaps for this role', ctx.fit, true)
  block('Company facts (never a fact about the person)', ctx.company, true)
  block('History with this employer', ctx.history, true)
  block("The person's saved answers (their own words)", ctx.answers, false)
  block("The person's profile facts", ctx.profile, false)
  return parts.join('\n\n')
}

/** The person's own words only: what a claim about the person may rest on. Never employer text. */
export function personEvidence(ctx: ApplyContext): string {
  return [...ctx.answers, ...ctx.profile].map((i) => i.text).join('\n')
}

const STOP = new Set('with that this from your will have they their about into more also been were what such than them these those which while where when over only other must including across years year the and for are you our'.split(' '))
const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))

/** True when `text` uses three or more of `source`'s words (every word, for a source of one or two). */
export function sharesWords(source: string, text: string): boolean {
  const have = tokens(text)
  const words = tokens(source)
  let shared = 0
  for (const w of words) if (have.has(w)) shared++
  return shared >= 3 || (words.size > 0 && words.size < 3 && shared === words.size)
}

/**
 * The sources behind a finished text: the person's own sources whose words the text uses (three shared words or
 * more), plus the employer sources that steered it. Code only, so "Built from" is a fact about the rows read.
 */
export function sourcesUsed(ctx: ApplyContext, text: string): ContextSource[] {
  const out = new Map<string, ContextSource>()
  const add = (s: ContextSource) => out.set(`${s.table}:${s.id}:${s.label}`, s)
  for (const i of [...ctx.answers, ...ctx.profile]) if (sharesWords(i.text, text)) add(i.source)
  if (ctx.requirements.length) add({ ...ctx.requirements[0].source, quote: undefined, label: `The posting's requirements, ${ctx.requirements.length} quoted` })
  if (ctx.company.length) add({ ...ctx.company[0].source, quote: undefined })
  return [...out.values()]
}
