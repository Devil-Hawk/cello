// Is this role the employer's own, open, unique and real? Pure, so every way of
// reading a site (board, search, sitemap, listing, rendered page) and the one
// sync that stores them can apply the same rules.
//
//   own      the role's address is on the employer's own site (its domain or its
//            careers host), or its applicant system verified as the employer's
//            (lib/ats/verify.ts); and a role that names an employer agrees with it.
//            A staffing agency or a reposting site is labelled as that and never
//            stored under the employer.
//   open     not past validThrough, not older than 180 days (lib/jobs/freshness).
//   unique   one row per requisition id, or normalised title plus location,
//            whichever tier read it.
//   real     not a talent-community sign-up, a general application or an event.

import type { AtsJob } from '../../ats/types'
import { normalizeEmployerName, onCompanyDomain, sameEmployerName } from '../../ats/verify'
import { classifyJob, isLowQuality } from '../../jobs/classify'
import { isStalePosting } from '../../jobs/freshness'
import type { TargetVerdict } from '../../targeting/roles'

export type ExcludeReason = 'agency' | 'reposting' | 'other_employer' | 'expired' | 'stale' | 'gone' | 'non_role' | 'duplicate'

export type Verdict = { keep: true } | { keep: false; why: ExcludeReason }

export type Excluded = Record<ExcludeReason, number>

export const emptyExcluded = (): Excluded => ({ agency: 0, reposting: 0, other_employer: 0, expired: 0, stale: 0, gone: 0, non_role: 0, duplicate: 0 })

export const STAFFING_AGENCIES = [
  'robert half',
  'randstad',
  'adecco',
  'insight global',
  'teksystems',
  'kforce',
  'aerotek',
  'manpowergroup',
  'manpower',
  'kelly services',
  'apex systems',
  'motion recruitment',
  'cybercoders',
  'jobot',
  'hays',
  'michael page',
  'harvey nash',
  'experis',
  'volt',
  'judge group',
]

export const REPOST_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'dice.com',
  'simplify.jobs',
  'jobgether.com',
  'builtin.com',
  'wellfound.com',
  'monster.com',
  'jooble.org',
  'talent.com',
  'careerbuilder.com',
  'snagajob.com',
  'lensa.com',
]

const NON_ROLE =
  /\b(talent (community|network|pool|pipeline)|general (application|interest)|open application|spontaneous application|expression of interest|future opportunit(y|ies)|career fair|info(rmation)? session|webinar|meetup|hackathon)\b/i

/** Employer names carry site codes ("Amazon.com Services LLC - A57"); the code is not part of the name. */
export function cleanEmployer(name: string): string {
  return name.replace(/\s+[-–]\s+[A-Z]\d{1,4}$/, '').trim()
}

export function agencyOf(name: string | undefined | null): string | null {
  if (!name) return null
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  const hit = STAFFING_AGENCIES.find((a) => n.includes(` ${a} `))
  return hit ?? null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function repostHostOf(url: string): string | null {
  const host = hostOf(url)
  return REPOST_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null
}

export interface JudgeContext {
  company: { name: string; domain: string | null; careerUrl?: string | null }
  now?: number
}

/** Does the employer a role names agree with the company (strictly, or as a legal-entity prefix: "Amazon Data Services")? */
export function employerAgrees(employer: string, companyName: string): boolean {
  const e = cleanEmployer(employer)
  if (sameEmployerName(e, companyName)) return true
  // Whole words only: "Metadata Inc" is not Meta, "Uberall GmbH" is not Uber, "Amazon Data Services" is Amazon.
  const words = (name: string) => name.replace(/\.(com|io|ai|co|dev|app|net|org|so|xyz|tech)\s*$/i, '').normalize('NFKD').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  const we = words(e)
  const wc = words(companyName)
  return normalizeEmployerName(companyName).length >= 3 && (we === wc || we.startsWith(`${wc} `))
}

/** Is the role's address on the employer's own site: its domain, or the host of its careers page? */
export function onOwnSite(url: string, ctx: JudgeContext): boolean {
  const { domain, careerUrl } = ctx.company
  if (onCompanyDomain(url, domain)) return true
  // A reposting site is the employer's own only when it IS the company's domain: a careers link on builtin.com does not make builtin.com the employer's site.
  if (repostHostOf(url)) return false
  const careerHost = careerUrl ? hostOf(careerUrl) : ''
  const host = hostOf(url)
  return !!careerHost && (host === careerHost || host.endsWith(`.${careerHost}`))
}

export function judgeRole(job: AtsJob, ctx: JudgeContext): Verdict {
  const now = ctx.now ?? Date.now()
  if (job.isEvent || NON_ROLE.test(job.title)) return { keep: false, why: 'non_role' }
  if (job.validThrough) {
    const t = Date.parse(job.validThrough)
    if (!Number.isNaN(t) && t < now) return { keep: false, why: 'expired' }
  }
  if (isStalePosting(job.postedAt, now)) return { keep: false, why: 'stale' }
  // A tracked staffing firm's own roles are its own: the rule is for another employer's roles posted by an agency.
  if (agencyOf(job.employer) && !employerAgrees(job.employer!, ctx.company.name)) return { keep: false, why: 'agency' }
  if (repostHostOf(job.url) && !onOwnSite(job.url, ctx)) return { keep: false, why: 'reposting' }
  if (job.employer && !employerAgrees(job.employer, ctx.company.name) && !onOwnSite(job.url, ctx)) {
    return { keep: false, why: 'other_employer' }
  }
  return { keep: true }
}

/**
 * The label a pasted link of a staffing agency or reposting site gets, in
 * words, or null when the role is not one of those.
 */
export function mislabelledSource(job: AtsJob, companyName: string): string | null {
  const agency = employerAgrees(job.employer ?? '', companyName) ? null : agencyOf(job.employer)
  if (agency) return `This posting is from ${job.employer}, a staffing agency, not ${companyName}.`
  const repost = repostHostOf(job.url)
  if (repost) return repostMessage(repost, companyName, 'posting')
  return null
}

/** In words, for a link on a reposting site: who it is, and that it is not the employer's careers site. */
export function repostMessage(host: string, companyName: string, noun: 'posting' | 'link' = 'link'): string {
  return `This ${noun} is on ${host}, a reposting site, not ${companyName}'s own careers site.`
}

// --- unique -----------------------------------------------------------------

const slugOf = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** One role's identity when its place is known. Without a place two roles with one title are not the same role (the same title in two cities). */
export const titleKey = (title: string, location: string | null | undefined) => (slugOf(location) ? `${slugOf(title)}|${slugOf(location)}` : '')

export interface StoredRole {
  title: string
  location: string | null
  source?: string | null
  open?: boolean
  externalId?: string
}

/**
 * One role per requisition id, else per normalised title plus location: within
 * the batch, and against open rows other sources already stored. A role the
 * same source already stored (same external id) is an update, not a duplicate.
 */
export function dedupeRoles(jobs: AtsJob[], stored: readonly StoredRole[], source: string): { kept: AtsJob[]; duplicates: number } {
  const storedIds = new Set(stored.map((s) => s.externalId).filter(Boolean))
  const otherSources = new Set(
    stored.filter((s) => s.open !== false && s.source && s.source !== source).map((s) => titleKey(s.title, s.location))
  )
  const reqs = new Set<string>()
  const titles = new Set<string>()
  const kept: AtsJob[] = []
  let duplicates = 0
  for (const job of jobs) {
    const key = titleKey(job.title, job.location)
    const req = job.requisitionId?.trim().toLowerCase()
    const isStored = storedIds.has(job.externalId)
    // Two requisitions are two openings even when they share a title and a place (Amazon lists the same role many times):
    // the title and place decide only for a role that carries no requisition id.
    // A row another source already stored under the same title and place is the same opening, whatever id this one carries.
    const dup = (req ? reqs.has(req) : key !== '' && titles.has(key)) || (key !== '' && !isStored && otherSources.has(key))
    if (dup) {
      duplicates++
      continue
    }
    if (req) reqs.add(req)
    if (key) titles.add(key)
    kept.push(job)
  }
  return { kept, duplicates }
}

// --- bounded ----------------------------------------------------------------

export const MAX_ROLES_PER_COMPANY = 200
export const MAX_DESCRIPTION_CHARS = 20_000

const RANK: Record<TargetVerdict, number> = { inside: 0, unclassified: 1, outside: 2 }

/**
 * Order roles for the per-company cap: inside the person's targets first, then
 * roles whose fit cannot be read, then the rest; newest first within each.
 * `verdictOf` is truth's targetVerdict over the job's classification.
 */
export function orderForCap<T>(
  items: readonly T[],
  verdictOf: (item: T) => TargetVerdict,
  postedAtOf: (item: T) => string | undefined = (item) => (item as AtsJob).postedAt
): T[] {
  return items
    .map((item, i) => ({ item, i, rank: RANK[verdictOf(item)], t: Date.parse(postedAtOf(item) ?? '') || 0 }))
    .sort((a, b) => a.rank - b.rank || b.t - a.t || a.i - b.i)
    .map((x) => x.item)
}

// --- confirmed ----------------------------------------------------------------

/**
 * The roles among pages read that are role pages at all. A page that has only
 * its site's shell (a script-built page whose title is "Atlassian Careers"
 * on every address) is not a role: a title that is a navigation word, the
 * company's own name, or the same few words on three or more pages with no
 * place, date or requisition id on any of them. A tier may claim success only
 * with one of these; without any, the site is "could not read", never "no roles".
 */
export function confirmRoles(jobs: readonly AtsJob[], companyName: string): AtsJob[] {
  const key = (t: string) => slugOf(t)
  const bare = (t: string) => normalizeEmployerName(t.replace(/\b(careers?|jobs?|career site|work with us|join us)\b/gi, ' '))
  const company = normalizeEmployerName(companyName)
  const bare0 = (j: AtsJob) => !j.location && !j.postedAt && !j.requisitionId
  const shared = new Map<string, number>()
  for (const j of jobs) if (bare0(j)) shared.set(key(j.title), (shared.get(key(j.title)) ?? 0) + 1)
  return jobs.filter((j) => {
    if (j.isEvent || NON_ROLE.test(j.title)) return false
    const c = classifyJob({ title: j.title.trim(), description: j.description, location: j.location, companyName })
    if (c.rejectReason || isLowQuality(c)) return false
    if (company && bare(j.title) === company) return false
    return !(bare0(j) && (shared.get(key(j.title)) ?? 0) >= 3)
  })
}
