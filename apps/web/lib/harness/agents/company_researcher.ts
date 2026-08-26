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
// Dual-source module (mirrors resume_optimizer.ts): a core fn usable from a
// request route with `apiKeys` OR a metered `llm`, plus a thin AgentFn wrapper.
// Degrades gracefully with no key: stores the non-LLM data with summary=null and
// partial=true — never crashes, never echoes a key.

import type { AgentFn, AdminClient, DecryptedApiKeys, LlmRunner, LlmRunOptions, LlmResult } from '../types'
import { callLlm, parseJsonLoose } from '../llm'
import { composeSystemPrompt, loadModeDoc } from '../prompts'
import { truncate } from '@/lib/sources/util'
import { collectPublicSignals, type PublicSignals } from '@/lib/dossier/sources'
import { computeCompIntel } from '@/lib/dossier/comp'
import { resolveVisaSignal } from '@/lib/dossier/visa'
import { upsertDossier, type DossierSignals, type SourceRef, type SummaryStatus } from '@/lib/dossier/store'
import { frameJobText } from '@/lib/security/job-text'
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

function buildSynthPrompt(company: DossierCompany, pub: PublicSignals): string {
  const verified: string[] = []
  if (pub.wikipediaSummary) verified.push('Wikipedia summary')
  if (pub.github?.description) verified.push('GitHub org description')
  if (pub.homeText) verified.push('official site (home)')
  if (pub.aboutText) verified.push('official site (about)')
  if (pub.careersText) verified.push('official site (careers)')
  if (pub.news.length > 0) verified.push(`${pub.news.length} verified news mention(s)`)

  const parts: string[] = [
    `COMPANY: ${company.name}${company.domain ? ` (${company.domain})` : ''}`,
    `VERIFIED EVIDENCE AVAILABLE: ${verified.join(', ') || 'none'}. Nothing else was corroborated as ` +
      'being about this specific company — do not treat its absence as evidence of anything.',
  ]
  if (pub.wikipediaSummary) parts.push(`WIKIPEDIA:\n${pub.wikipediaSummary}`)
  if (pub.github?.description) {
    const g = pub.github
    // INJECTION DEFENCE (lib/security/job-text.ts): the org description comes
    // from the public GitHub API, i.e. whatever the company itself wrote
    // there — third-party text, not a job posting, but every bit as
    // attacker-adjacent (any org can set its own description). Flagged by a
    // prior audit as an unframed input alongside job text; framed here with
    // the same helper for the same reason (see that file's header).
    const repoNote = g.publicRepos != null ? ` (public repos: ${g.publicRepos})` : ''
    parts.push(`GITHUB ORG:\n${frameJobText(g.description, { label: 'GITHUB ORG DESCRIPTION' })}${repoNote}`)
  }
  if (pub.homeText) parts.push(`OFFICIAL SITE (home):\n${pub.homeText}`)
  if (pub.aboutText) parts.push(`OFFICIAL SITE (about):\n${pub.aboutText}`)
  if (pub.careersText) parts.push(`OFFICIAL SITE (careers):\n${pub.careersText}`)
  if (pub.news.length > 0) {
    parts.push(`VERIFIED RECENT NEWS HEADLINES:\n${pub.news.map((n) => `- ${n.title}`).join('\n')}`)
  }
  return parts.join('\n\n').slice(0, 12_000)
}

interface SynthResult {
  summary: string
  whatTheyWant: string | null
  uncertainty: string | null
  funding: string | null
  headcountTrend: string | null
  culture: string | null
  techStack: string[]
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()).slice(0, 24)
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/** Does the bundle have anything worth asking the LLM to synthesize? */
function hasSynthesizableText(pub: PublicSignals): boolean {
  return Boolean(
    pub.wikipediaSummary || pub.homeText || pub.aboutText || pub.careersText || pub.github?.description
  )
}

/** Short, sanitized explanation of an LLM failure — never a raw key or stack trace. */
function sanitizeErrorDetail(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const redacted = msg
    .replace(/sk-[a-zA-Z0-9_-]{10,}/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  return truncate(redacted, 240)
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
      ? (opts: LlmRunOptions): Promise<LlmResult> => callLlm(args.apiKeys!, opts, args.signal)
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
  let summary: string | null = null
  let synth: SynthResult | null = null
  let summaryUnavailable: SummaryStatus | null = null

  if (!run) {
    summaryUnavailable = { reason: 'no-key' }
  } else if (!hasSynthesizableText(pub)) {
    summaryUnavailable = { reason: 'no-signals' }
  } else {
    try {
      const res = await run({
        // _shared.md + _voice.md + prompts/company_researcher.md (the
        // house-style mode document — see docs/PROMPT-GENERATOR.md) is
        // identical for every company this call ever runs against — the
        // cheapest possible cache prefix to mark.
        system: composeSystemPrompt({ mode: loadModeDoc('company_researcher') }),
        prompt: buildSynthPrompt(company, pub),
        json: true,
        maxTokens: 700,
        temperature: 0.2,
        cachePrefix: true,
      })
      const raw = parseJsonLoose<Partial<SynthResult>>(res.content)
      synth = {
        summary: nullableStr(raw.summary) ?? '',
        whatTheyWant: nullableStr(raw.whatTheyWant),
        uncertainty: nullableStr(raw.uncertainty),
        funding: nullableStr(raw.funding),
        headcountTrend: nullableStr(raw.headcountTrend),
        culture: nullableStr(raw.culture),
        techStack: strArray(raw.techStack),
      }
      summary = synth.summary || null
      if (!summary) {
        summaryUnavailable = {
          reason: 'generation-failed',
          detail: 'The model returned an empty summary.',
        }
      }
    } catch (e) {
      summaryUnavailable = { reason: 'generation-failed', detail: sanitizeErrorDetail(e) }
    }
  }

  // `partial` reflects whether REAL AI reasoning happened, independent of any
  // non-AI fallback text applied below (a Wikipedia extract is not reasoning).
  const partial = Boolean(summaryUnavailable)

  // Assemble the stored signals. Verified news items carry WHY they qualified
  // (matchedBy, set by lib/dossier/sources.ts) so the panel can show provenance.
  const news: SourceRef[] = pub.news.map((n) => ({ title: n.title, url: n.url, matchedBy: n.matchedBy }))
  const signals: DossierSignals = synth
    ? {
        funding: synth.funding,
        headcountTrend: synth.headcountTrend,
        news,
        culture: synth.culture,
        techStack: synth.techStack,
        whatTheyWant: synth.whatTheyWant,
        uncertainty: synth.uncertainty,
        summarySource: 'ai',
        summaryUnavailable,
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
        raw: {
          wikipediaSummary: pub.wikipediaSummary ?? null,
          github: pub.github ?? null,
        },
      }

  // Fall back to the Wikipedia extract as a literal (non-synthesized) summary
  // when there is no AI summary. Tagged as 'wikipedia' — never presented as
  // reasoning that didn't happen — and clears summaryUnavailable since there
  // IS now something to show, even though `partial` (computed above) still
  // honestly reflects that no AI reasoning occurred.
  if (!summary && pub.wikipediaSummary) {
    summary = pub.wikipediaSummary
    signals.summarySource = 'wikipedia'
    signals.summaryUnavailable = null
  }

  // 4a) Persist the synthesized summary (AI or Wikipedia-fallback, whichever
  // ended up set above) into the KB, AFTER synthesis. company_dossiers below
  // stays the structured store of record; this is a second, searchable copy.
  if (summary) await persistToKb(`company=${company.id} dossier-summary`, () => ingestDossierSummary(admin, userId, company.id, summary!))

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
    .from('jobs')
    .select('salary_range, title')
    .eq('company_id', companyId)
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
