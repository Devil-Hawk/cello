// The queue for pages only a browser can read. A job is queued here (queueRenderJob), claimed by the pull worker
// (packages/scrapers/src/worker.py) through POST /api/directory/jobs/claim, and settled by POST /api/directory/jobs/[id]
// with what the worker saw. The worker never holds a database key: both doors check a signature (lib/clock/sign.ts).
//
// Nothing here fetches. A careers page the worker read is settled from the HTML it posted; the board APIs the
// verifier then calls are the ones it always calls. No address or search is ever logged.

import type { SupabaseClient } from '@supabase/supabase-js'
import { findBoardLinks } from '../ats/careers-page'
import { detectFromUrl } from '../ats/detect'
import { continueSecret, MAX_EXP_AHEAD_S, verifySigned } from '../clock/sign'
import { readSite } from '../ingest/reader'
import { ReaderError, type SiteFetcher } from '../ingest/reader/site-fetch'
import { NO_TARGETS } from '../ingest/reader/targets'
import { settleCandidate, writeEmployer, type CandidateRow, type VerifyDeps } from './verify-directory'

type Db = SupabaseClient<any, any, any>

export type RenderJobKind = 'careers_page' | 'web_search'

export interface RenderJob {
  id: string
  kind: RenderJobKind
  candidate_id: string | null
  url: string | null
  query: string | null
  state: string
  /** The person who asked, who follows the employer when the answer proves one. */
  requested_by?: string | null
}

export interface QueueInput {
  kind: RenderJobKind
  candidateId?: string | null
  url?: string | null
  query?: string | null
  requestedBy?: string | null
}

const isHttp = (u: string) => u.length <= 2000 && /^https?:\/\/[^\s]+$/i.test(u)

/**
 * Queue one browser read and return the job's id, or null when the input is not a job. A page or search that is
 * already waiting or being read is not queued twice. A candidate that waits for the worker is left alone by the
 * sweep for a day, so the sweep's plain read does not mark it failed first.
 */
export async function queueRenderJob(db: Db, input: QueueInput): Promise<string | null> {
  const url = input.url?.trim() || null
  const query = input.query?.trim() || null
  if (input.kind === 'careers_page' ? !url || !isHttp(url) : !query || query.length > 200) return null
  const target = input.kind === 'careers_page' ? (['url', url] as const) : (['query', query] as const)

  const { data: waiting } = await db.from('render_jobs').select('id').eq('kind', input.kind).in('state', ['queued', 'claimed']).eq(target[0], target[1]).limit(1).maybeSingle()
  if (waiting) return (waiting as { id: string }).id

  const { data, error } = await db
    .from('render_jobs')
    .insert({ kind: input.kind, candidate_id: input.candidateId ?? null, url: input.kind === 'careers_page' ? url : null, query: input.kind === 'web_search' ? query : null, requested_by: input.requestedBy ?? null })
    .select('id')
    .single()
  if (error || !data) return null
  if (input.candidateId) await db.from('directory_candidates').update({ next_check_at: new Date(Date.now() + 86_400_000).toISOString() }).eq('id', input.candidateId)
  return (data as { id: string }).id
}

// --- the signed doors ----------------------------------------------------------

export type Signed = { ok: true; body: Record<string, unknown> } | { ok: false; status: 400 | 401 | 503 }

/**
 * The body of a worker request, once its signature over the exact bytes checks out and its `exp` is neither past nor
 * far ahead. The signature is verified before the body is parsed; every refusal of the signature or the expiry is the same 401.
 */
export function readSigned(raw: string, signature: string | null, nowMs: number = Date.now()): Signed {
  let key: string
  try {
    key = continueSecret()
  } catch {
    return { ok: false, status: 503 } // the secret is not set on this deployment
  }
  if (!verifySigned(raw, signature, key)) return { ok: false, status: 401 }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400 }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400 }
  const exp = (body as { exp?: unknown }).exp
  const now = Math.floor(nowMs / 1000)
  if (typeof exp !== 'number' || exp < now || exp > now + MAX_EXP_AHEAD_S + 5) return { ok: false, status: 401 }
  return { ok: true, body: body as Record<string, unknown> }
}

// --- settling a job --------------------------------------------------------------

/** A class name the worker reported (never message text), or a plain "Error". */
const failureClass = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v) ? v : 'Error')

const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/

function cleanDomains(v: unknown): { domain: string; title: string }[] | null {
  if (!Array.isArray(v)) return null
  const out: { domain: string; title: string }[] = []
  for (const d of v.slice(0, 3)) {
    const domain = typeof d?.domain === 'string' ? d.domain.trim().toLowerCase() : ''
    if (!DOMAIN.test(domain) || domain.length > 253) return null
    out.push({ domain, title: typeof d.title === 'string' ? d.title.trim().slice(0, 200) : '' })
  }
  return out
}

const hostOf = (url: unknown): string | null => {
  try {
    return typeof url === 'string' ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : null
  } catch {
    return null
  }
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** Is `url` the page the worker was sent to? Scheme, a leading www. and a trailing slash do not matter. */
function samePage(url: string, page: string): boolean {
  try {
    const [a, b] = [new URL(url), new URL(page)]
    const key = (u: URL) => `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`
    return key(a) === key(b)
  } catch {
    return false
  }
}

/** A fetcher that answers the one address the worker read with the HTML it posted, and refuses every other: nothing else is fetched. */
function postedPage(pageUrl: string, html: string): SiteFetcher {
  let requests = 0
  const refuse = (): never => {
    throw new ReaderError('unreachable')
  }
  return {
    mode: 'inline',
    async get(url) {
      requests++
      if (!samePage(url, pageUrl)) return refuse()
      return { status: 200, ok: true, text: html, finalUrl: pageUrl, contentType: 'text/html' }
    },
    async json() {
      return refuse()
    },
    async gate() {
      refuse()
    },
    async redirectOf() {
      return null
    },
    async allowed(url) {
      return samePage(url, pageUrl)
    },
    async sitemapsOf() {
      return []
    },
    spent: () => ({ requests, bytes: html.length }),
  }
}

/**
 * Settle one claimed job from the worker's posted result. A page that was read is verified like any candidate's
 * (settleCandidate, as a person's check): the boards its HTML links to are the evidence. A page that links no board but
 * lists roles itself is read from the posted HTML alone (postedPage) and accepted as the employer's own site
 * (verified_by careers_url_host), as a live read of it would be. The HTML is used only when it was read on the
 * candidate's own domain. Returns the employer that was proven, if any, so the caller can follow it for the requester.
 */
export async function finishRenderJob(db: Db, job: RenderJob, body: Record<string, unknown>, deps: VerifyDeps): Promise<{ employerId: string | null }> {
  // Only a job still claimed is finished here: a second answer that lands while the first is settling writes nothing.
  const finish = async (state: 'done' | 'failed', patch: { result?: unknown; failure?: string }) => {
    await db.from('render_jobs').update({ state, done_at: new Date(deps.now()).toISOString(), ...patch }).eq('id', job.id).eq('state', 'claimed')
    return { employerId: null as string | null }
  }

  if (body.ok !== true) return finish('failed', { failure: failureClass(body.error) })
  if (job.kind === 'web_search') {
    const domains = cleanDomains(body.domains)
    return domains ? finish('done', { result: { domains } }) : finish('failed', { failure: 'BadResult' })
  }

  const html = typeof body.html === 'string' ? body.html : ''
  const rung = typeof body.rung === 'string' ? body.rung.slice(0, 20) : null
  if (!html) return finish('failed', { failure: 'EmptyPage' })
  const { data } = job.candidate_id ? await db.from('directory_candidates').select('id, name, domain, ats_provider, ats_token, source, failed_reads').eq('id', job.candidate_id).maybeSingle() : { data: null }
  const candidate = data as CandidateRow | null
  if (!candidate) return finish('done', { result: { rung } }) // a read with nobody waiting on it
  const host = hostOf(body.final_url) ?? hostOf(job.url)
  const own = !!(host && candidate.domain && onDomain(host, candidate.domain))
  const boards = own ? findBoardLinks(html, (u) => detectFromUrl({ careerUrl: u, domain: null })) : []
  const settled = await settleCandidate(db, candidate, { ...deps, pageBoards: async () => boards }, { person: true })
  if (settled.state === 'verified') {
    await finish('done', { result: { rung, settled: 'verified', employer_id: settled.employerId } })
    return { employerId: settled.employerId }
  }

  // No board proved it: the page may list roles itself.
  const pageUrl = typeof body.final_url === 'string' && own && hostOf(body.final_url) ? body.final_url : job.url
  if (own && pageUrl) {
    const read = await readSite({ company: { name: candidate.name, domain: candidate.domain, careerUrl: pageUrl }, targets: NO_TARGETS }, { fetcher: postedPage(pageUrl, html), renderedLater: false })
    if (read.tier && read.tier !== 'board' && read.jobs.length > 0) {
      const written = await writeEmployer(db, { name: candidate.name, domain: candidate.domain, careersUrl: pageUrl, provider: null, token: null, verifiedBy: 'careers_url_host', source: 'person', openCount: read.complete ? read.jobs.length : null, readTier: read.tier, keepExisting: true }, deps.now)
      if (written.ok) {
        const at = new Date(deps.now()).toISOString()
        await db.from('directory_candidates').update({ state: 'verified', employer_id: written.employerId, fail_reason: null, failed_reads: 0, checked_at: at }).eq('id', candidate.id)
        await finish('done', { result: { rung, settled: 'verified', employer_id: written.employerId, via: 'site' } })
        return { employerId: written.employerId }
      }
    }
  }
  return finish('done', { result: { rung, settled: settled.state, ...(settled.state === 'failed' ? { reason: settled.reason } : {}) } })
}
