// Agent: company_researcher — assemble ONE dossier per company from FREE public
// sources, compute comp intelligence + a visa-sponsorship signal, and upsert it
// into public.company_dossiers (unique per company_id).
//
// Sources are strictly free + legitimate (see lib/dossier/sources.ts): the
// company's own site, Wikipedia, HN, the public GitHub org API. NO paid vendors,
// NO logins, NO LinkedIn. Comp comes from first-party posted salary_range +
// public baselines (always with a confidence). The visa signal is likely/
// unlikely/unknown — never a hard claim.
//
// Every statement in the research cites the numbered excerpts (S1..) that state
// it, and code drops any statement whose excerpts are missing or do not contain
// the names and numbers it uses. Each excerpt gets its own character budget, so
// the careers page and the news are never the part that gets cut off. Wikipedia
// is a labelled source, never the summary.
//
// Dual-source module (mirrors resume_optimizer.ts): a core fn usable from a
// request route with `apiKeys` OR a metered `llm`, plus a thin AgentFn wrapper.
// Degrades gracefully with no key: stores the non-LLM data with summary=null and
// partial=true — never crashes, never echoes a key.

import type { AgentFn, AdminClient, DecryptedApiKeys, LlmRunner, LlmRunOptions, LlmResult } from '../types'
import { callLlm, parseJsonLoose } from '../llm'
import { TruncatedResponseError } from '../providers'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../prompts'
import { truncate } from '@/lib/sources/util'
import { collectPublicSignals, type PublicSignals } from '@/lib/dossier/sources'
import { computeCompIntel } from '@/lib/dossier/comp'
import { resolveVisaSignal } from '@/lib/dossier/visa'
import {
  upsertDossier,
  type CitedField,
  type DossierCitation,
  type DossierSignals,
  type DossierSource,
  type ExcerptKind,
  type SourceRef,
  type SummaryStatus,
} from '@/lib/dossier/store'
import { frameJobTextList } from '@/lib/security/job-text'
import { unbackedTokens } from '@/lib/dossier/backing'
import { ingestCompanyPage, ingestDossierSummary } from '@/lib/kb/ingest'
import { captureError } from '@/lib/observability/sentry'

export interface DossierCompany {
  id: string
  name: string
  domain: string | null
}

export interface DossierJob {
  salary_range: string | null
  title?: string | null
}

export interface GenerateDossierArgs {
  company: DossierCompany
  jobs: DossierJob[]
  /** Preferred: budget-aware runner (harness). */
  llm?: LlmRunner
  /** Fallback: direct OpenRouter call with the user's key. */
  apiKeys?: DecryptedApiKeys
  admin: AdminClient
  userId: string
  signal?: AbortSignal
}

export interface CompanyResearcherResult {
  dossierId: string | null
  companyId: string
  sponsorsVisa: 'likely' | 'unlikely' | 'unknown'
  hasSummary: boolean
  sourceCount: number
  partial?: boolean
  /** Set whenever hasSummary is false — the machine-readable reason, never a guess. */
  summaryUnavailable?: SummaryStatus
}

// --- excerpts ------------------------------------------------------------------

export interface Excerpt {
  id: string
  kind: ExcerptKind
  url: string
  title: string
  text: string
}

/** Characters each kind of excerpt may carry into the prompt. */
const BUDGET: Record<Exclude<ExcerptKind, 'news'>, number> = { wikipedia: 1500, github: 400, home: 2500, about: 2500, careers: 2500 }
const MAX_NEWS = 10

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '')
}

/** The company's site root from its stored domain, for when the collected sources carry none. */
function siteRoot(company: DossierCompany): string {
  const host = (company.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return host ? `https://${host}` : ''
}

/**
 * The numbered excerpts the research is written from: the company's own pages,
 * Wikipedia, the GitHub org and up to ten news headlines, each cut to its own
 * budget rather than the whole bundle being cut from the end.
 */
export function buildExcerpts(company: DossierCompany, pub: PublicSignals): Excerpt[] {
  const sources = pub.sources ?? []
  const urlOf = (matchedBy: SourceRef['matchedBy'], pick?: (u: string) => boolean): string | undefined =>
    sources.find((s) => s.matchedBy === matchedBy && (!pick || pick(s.url)))?.url
  const root = siteRoot(company)
  const items: Omit<Excerpt, 'id'>[] = []
  if (pub.homeText) {
    items.push({ kind: 'home', url: urlOf('official-site', (u) => !/\/about\/?$/.test(u)) ?? root, title: `${company.name} site`, text: clip(pub.homeText, BUDGET.home) })
  }
  if (pub.aboutText) {
    items.push({ kind: 'about', url: urlOf('official-site', (u) => /\/about\/?$/.test(u)) ?? (root ? `${root}/about` : ''), title: `${company.name} about page`, text: clip(pub.aboutText, BUDGET.about) })
  }
  if (pub.careersText) {
    items.push({ kind: 'careers', url: urlOf('careers') ?? (root ? `${root}/careers` : ''), title: `${company.name} careers`, text: clip(pub.careersText, BUDGET.careers) })
  }
  if (pub.wikipediaSummary) {
    items.push({ kind: 'wikipedia', url: pub.wikipediaUrl ?? urlOf('wikipedia') ?? '', title: 'Wikipedia', text: clip(pub.wikipediaSummary, BUDGET.wikipedia) })
  }
  if (pub.github?.description) {
    const login = pub.github.login
    items.push({ kind: 'github', url: urlOf('github') ?? (login ? `https://github.com/${login}` : ''), title: 'GitHub', text: clip(pub.github.description, BUDGET.github) })
  }
  for (const n of pub.news.slice(0, MAX_NEWS)) items.push({ kind: 'news', url: n.url, title: n.title, text: n.title })
  return items.map((e, i) => ({ ...e, id: `S${i + 1}` }))
}

const KIND_LABEL: Record<ExcerptKind, string> = {
  home: 'company site',
  about: 'company about page',
  careers: 'careers page',
  wikipedia: 'Wikipedia',
  github: 'GitHub',
  news: 'news headline',
}

function buildSynthPrompt(company: DossierCompany, excerpts: Excerpt[]): string {
  const kinds = [...new Set(excerpts.map((e) => KIND_LABEL[e.kind]))]
  const list = excerpts.map((e) => ({ id: e.id, text: `${KIND_LABEL[e.kind]}, ${e.title}${e.url ? `, ${e.url}` : ''}\n${e.text}` }))
  return [
    `COMPANY: ${company.name}${company.domain ? ` (${company.domain})` : ''}`,
    `Source kinds available: ${kinds.join(', ') || 'none'}. Nothing else was corroborated as being about this company; do not treat its absence as evidence of anything.`,
    '',
    frameJobTextList(list, { label: 'EXCERPT', maxChars: 3000 }),
    '',
    'Write the research note as JSON per the system rules.',
  ].join('\n')
}

// --- synthesis -----------------------------------------------------------------

interface Statement {
  text: string
  sources: string[]
}

export interface DossierSynthesis {
  /** The verified summary sentences, joined. Null when none survived. */
  summary: string | null
  whatTheyWant: string | null
  uncertainty: string | null
  funding: string | null
  headcountTrend: string | null
  culture: string | null
  techStack: string[]
  /** Every shown statement with the excerpts that back it. */
  citations: DossierCitation[]
  /** Statements left out because no source backed them. */
  dropped: number
}

function asStatement(v: unknown): Statement | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { text?: unknown; sources?: unknown }
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  const sources = Array.isArray(o.sources) ? o.sources.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toUpperCase()) : []
  return text ? { text, sources } : null
}

/**
 * Keep a statement only when it cites excerpts that exist and the excerpts
 * contain what it states (the names, numbers and dates it uses). `allow` is the
 * company's own name, which the excerpts need not repeat.
 */
function backed(st: Statement, byId: Map<string, Excerpt>, company: string): Statement | null {
  const ids = [...new Set(st.sources.filter((id) => byId.has(id)))]
  if (ids.length === 0) return null
  const support = ids.map((id) => byId.get(id)!.text).join('\n')
  if (unbackedTokens(st.text, support, [company]).length > 0) return null
  return { text: st.text, sources: ids }
}

/** Verify what the model returned against the excerpts it was given. Pure. */
export function verifyCitations(raw: Record<string, unknown>, excerpts: Excerpt[], company: string): DossierSynthesis {
  const byId = new Map(excerpts.map((e) => [e.id, e]))
  const citations: DossierCitation[] = []
  let dropped = 0

  const take = (field: CitedField, v: unknown): Statement | null => {
    const st = asStatement(v)
    if (!st) return null
    const ok = backed(st, byId, company)
    if (!ok) {
      dropped++
      return null
    }
    citations.push({ field, text: ok.text, sources: ok.sources })
    return ok
  }

  const summaryItems = (Array.isArray(raw.summary) ? raw.summary : []).map((v) => take('summary', v)).filter((s): s is Statement => s !== null)
  // A bare string where a statement was asked for has no source to check, so it is dropped.
  if (typeof raw.summary === 'string' && raw.summary.trim()) dropped++

  const field = (key: CitedField): string | null => take(key, raw[key])?.text ?? null
  const whatTheyWant = field('whatTheyWant')
  const funding = field('funding')
  const headcountTrend = field('headcountTrend')
  const culture = field('culture')

  const techStack: string[] = []
  const techSources = new Set<string>()
  for (const t of Array.isArray(raw.techStack) ? raw.techStack : []) {
    const item = typeof t === 'string' ? { name: t, sources: [] as string[] } : (t as { name?: unknown; sources?: unknown } | null)
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    const ids = Array.isArray(item?.sources) ? (item.sources as unknown[]).filter((s): s is string => typeof s === 'string').map((s) => s.trim().toUpperCase()).filter((id) => byId.has(id)) : []
    // The technology's name has to be in a cited excerpt.
    const named = name && ids.some((id) => byId.get(id)!.text.toLowerCase().includes(name.toLowerCase()))
    if (!named) {
      if (name) dropped++
      continue
    }
    techStack.push(name)
    ids.forEach((id) => techSources.add(id))
  }
  if (techStack.length > 0) citations.push({ field: 'techStack', text: techStack.join(', '), sources: [...techSources] })

  // `uncertainty` says what is not known, so it needs no source; one that cites
  // excerpts is still held to them.
  const unc = typeof raw.uncertainty === 'string' ? { text: raw.uncertainty.trim(), sources: [] as string[] } : asStatement(raw.uncertainty)
  const uncertainty = unc?.text || null

  return {
    summary: summaryItems.length > 0 ? summaryItems.map((s) => s.text).join(' ') : null,
    whatTheyWant,
    uncertainty,
    funding,
    headcountTrend,
    culture,
    techStack,
    citations,
    dropped,
  }
}

const MAX_TOKENS = 1600
const RETRY_TOKENS = 3200

export type SynthesisResult =
  | { ok: true; synthesis: DossierSynthesis }
  | { ok: false; status: SummaryStatus }

/** Short, sanitized explanation of an LLM failure — never a raw key or stack trace. */
function sanitizeErrorDetail(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const redacted = msg
    .replace(/sk-[a-zA-Z0-9_-]{10,}/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  return truncate(redacted, 240)
}

/**
 * One model call over the excerpts, then the checks code can make. A cut-off
 * answer is retried once at twice the budget; a second cut-off is reported as
 * such. Pure over `run`, so the evals drive it without a network or database.
 */
export async function synthesizeDossier(run: LlmRunner, company: DossierCompany, pub: PublicSignals): Promise<SynthesisResult> {
  const excerpts = buildExcerpts(company, pub)
  const base = {
    // _shared.md + _voice.md + prompts/company_researcher.md is identical for
    // every company this call ever runs against: the cheapest cache prefix to mark.
    system: composeSystemPrompt({ mode: loadModeDoc('company_researcher') }),
    promptRef: promptRef('company_researcher'),
    prompt: buildSynthPrompt(company, excerpts),
    json: true,
    maxTokens: MAX_TOKENS,
    temperature: 0.2,
    cachePrefix: true,
  }
  let res: LlmResult
  try {
    try {
      res = await run(base)
    } catch (e) {
      if (!(e instanceof TruncatedResponseError)) throw e
      res = await run({ ...base, maxTokens: RETRY_TOKENS })
    }
  } catch (e) {
    return {
      ok: false,
      status: { reason: 'generation-failed', detail: e instanceof TruncatedResponseError ? 'The answer was cut off twice.' : sanitizeErrorDetail(e) },
    }
  }
  let raw: Record<string, unknown>
  try {
    raw = parseJsonLoose<Record<string, unknown>>(res.content)
  } catch (e) {
    return { ok: false, status: { reason: 'generation-failed', detail: sanitizeErrorDetail(e) } }
  }
  const synthesis = verifyCitations(raw, excerpts, company.name)
  if (!synthesis.summary) {
    return {
      ok: false,
      status: {
        reason: 'generation-failed',
        detail: synthesis.dropped > 0 ? 'None of the statements could be tied to a source.' : 'The model returned an empty summary.',
      },
    }
  }
  return { ok: true, synthesis }
}

/** Does the bundle have anything worth asking the LLM to synthesize? */
function hasSynthesizableText(pub: PublicSignals): boolean {
  return Boolean(pub.wikipediaSummary || pub.homeText || pub.aboutText || pub.careersText || pub.github?.description)
}

/**
 * Persist to the KB without ever failing the dossier pipeline over it — a KB
 * write is a second, searchable copy of data the structured company_dossiers
 * row already owns, so a write failure here (RLS misconfig, transient DB
 * error) must never block that row from being upserted.
 */
async function persistToKb(label: string, write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    console.error(`[company_researcher:kb-write-failed] ${label}: ${error.message}`)
    void captureError(error, { tags: { area: 'kb', phase: 'ingest' }, extra: { label } })
  }
}

/**
 * Full dossier pipeline. Provide either `llm` (metered) or `apiKeys` (direct).
 * With no usable key it still runs every free fetch + comp + visa and persists a
 * PARTIAL dossier (summary=null).
 */
export async function generateDossier(args: GenerateDossierArgs): Promise<CompanyResearcherResult> {
  const { company, jobs, admin, userId } = args

  // Adapt whichever LLM source was provided (or none) into a single runner.
  const run: LlmRunner | null =
    args.llm ??
    (args.apiKeys?.openrouter
      ? (opts: LlmRunOptions): Promise<LlmResult> => callLlm(args.apiKeys!, { ...opts, name: opts.name ?? 'research-company' }, args.signal)
      : null)

  // 1) Free public fetches (keyless).
  const pub = await collectPublicSignals({ name: company.name, domain: company.domain })

  // 1a) Persist the raw page text into the KB BEFORE synthesis (step 4 below
  // reasons over it, but never sees it again once this function returns) so
  // contact mining and KB search can read it back — see lib/kb/ingest.ts and
  // lib/contacts/sources.ts's use of readFreshCompanyPages.
  if (pub.homeText) await persistToKb(`company=${company.id} page=home`, () => ingestCompanyPage(admin, userId, company.id, 'home', pub.homeText!))
  if (pub.aboutText) await persistToKb(`company=${company.id} page=about`, () => ingestCompanyPage(admin, userId, company.id, 'about', pub.aboutText!))
  if (pub.careersText) await persistToKb(`company=${company.id} page=careers`, () => ingestCompanyPage(admin, userId, company.id, 'careers', pub.careersText!))

  // 2) Comp intel from first-party posted salary ranges + public baseline.
  const compIntel = computeCompIntel(jobs)

  // 3) Visa signal (careers-page statement -> curated public data -> unknown).
  const visa = await resolveVisaSignal({
    name: company.name,
    careersText: pub.careersText,
    run,
    signal: args.signal,
  })

  // 4) One LLM synthesis of summary + reasoning (skipped with no key, or with
  // nothing worth reasoning about). `summaryUnavailable` is ALWAYS set when
  // `summary` ends up null — never left for the UI to guess at.
  const excerpts = buildExcerpts(company, pub)
  let synthesis: DossierSynthesis | null = null
  let summaryUnavailable: SummaryStatus | null = null

  if (!run) {
    summaryUnavailable = { reason: 'no-key' }
  } else if (!hasSynthesizableText(pub)) {
    summaryUnavailable = { reason: 'no-signals' }
  } else {
    const outcome = await synthesizeDossier(run, company, pub)
    if (outcome.ok) synthesis = outcome.synthesis
    else summaryUnavailable = outcome.status
  }
  const summary = synthesis?.summary ?? null

  // `partial` reflects whether REAL AI reasoning happened. Wikipedia is never
  // used as the summary: when the model did not write one, summary stays null and
  // the reason says why, while Wikipedia is still shown as a labelled source.
  const partial = Boolean(summaryUnavailable)

  // The numbered sources the statements cite, and what the research rests on.
  const sourceList: DossierSource[] = excerpts.map((e) => ({ id: e.id, kind: e.kind, title: e.title, url: e.url }))
  const kinds = [...new Set(excerpts.map((e) => e.kind))]
  const evidence = { kinds, wikipediaOnly: kinds.length > 0 && kinds.every((k) => k === 'wikipedia') }

  // Assemble the stored signals. Verified news items carry WHY they qualified
  // (matchedBy, set by lib/dossier/sources.ts) so the panel can show provenance.
  const news: SourceRef[] = pub.news.map((n) => ({ title: n.title, url: n.url, matchedBy: n.matchedBy }))
  const signals: DossierSignals = synthesis
    ? {
        funding: synthesis.funding,
        headcountTrend: synthesis.headcountTrend,
        news,
        culture: synthesis.culture,
        techStack: synthesis.techStack,
        whatTheyWant: synthesis.whatTheyWant,
        uncertainty: synthesis.uncertainty,
        summarySource: 'ai',
        summaryUnavailable: null,
        sourceList,
        citations: synthesis.citations,
        evidence,
        dropped: synthesis.dropped,
      }
    : {
        funding: null,
        headcountTrend: null,
        news,
        culture: null,
        techStack: [],
        whatTheyWant: null,
        uncertainty: null,
        summarySource: null,
        summaryUnavailable,
        sourceList,
        citations: [],
        evidence,
        dropped: 0,
        raw: {
          wikipediaSummary: pub.wikipediaSummary ?? null,
          github: pub.github ?? null,
        },
      }

  // 4a) Persist the synthesized summary into the KB, AFTER synthesis.
  // company_dossiers below stays the structured store of record; this is a
  // second, searchable copy.
  if (summary) await persistToKb(`company=${company.id} dossier-summary`, () => ingestDossierSummary(admin, userId, company.id, summary))

  // 5) Upsert (unique per company_id).
  let dossierId: string | null = null
  try {
    const row = await upsertDossier(admin, {
      company_id: company.id,
      user_id: userId,
      summary,
      signals,
      comp_intel: compIntel,
      sponsors_visa: visa.signal,
      sources: pub.sources,
    })
    dossierId = row.id
  } catch {
    dossierId = null
  }

  return {
    dossierId,
    companyId: company.id,
    sponsorsVisa: visa.signal,
    hasSummary: Boolean(summary),
    sourceCount: pub.sources.length,
    partial: partial || undefined,
    summaryUnavailable: signals.summaryUnavailable ?? undefined,
  }
}

// --- Harness AgentFn wrapper -------------------------------------------------

interface CompanyRow {
  id: string
  name: string
  domain: string | null
}
interface JobRow {
  salary_range: string | null
  title: string | null
}

export const company_researcher: AgentFn = async (ctx) => {
  const input = (ctx.input ?? {}) as { companyId?: unknown }
  const companyId = typeof input.companyId === 'string' ? input.companyId : ''
  if (!companyId) {
    return {
      output: {
        dossierId: null,
        companyId: '',
        sponsorsVisa: 'unknown',
        hasSummary: false,
        sourceCount: 0,
        partial: true,
      },
      tokensUsed: 0,
    }
  }

  const { data: companyData } = await ctx.admin
    .from('companies')
    .select('id, name, domain')
    .eq('id', companyId)
    .eq('user_id', ctx.userId)
    .single()
  const company = companyData as CompanyRow | null
  if (!company) {
    return {
      output: {
        dossierId: null,
        companyId,
        sponsorsVisa: 'unknown',
        hasSummary: false,
        sourceCount: 0,
        partial: true,
      },
      tokensUsed: 0,
    }
  }

  const { data: jobData } = await ctx.admin
    .from('person_jobs')
    .select('salary_range, title')
    .eq('viewer_id', ctx.userId)
    .eq('viewer_company_id', companyId)
  const jobs = (jobData as JobRow[]) ?? []

  const result = await generateDossier({
    company,
    jobs,
    llm: ctx.llm,
    admin: ctx.admin,
    userId: ctx.userId,
    signal: ctx.signal,
  })

  return { output: result, tokensUsed: 0 }
}
