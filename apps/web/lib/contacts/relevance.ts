// Which sourced contacts are worth showing for a SPECIFIC role.
//
// WHY THIS EXISTS
//   Contact sourcing mines a company's own pages, and company pages are where
//   companies put their executives. So the extractors reliably surface founders
//   and C-suite — and for a job application those are usually the least useful
//   people alive. Nobody is hired at a 7,000-person company by emailing its CEO;
//   the message does not reach them, and if it did they would forward it to the
//   recruiter you should have found instead.
//
//   But the opposite rule is just as wrong. At a twelve-person startup the
//   founder IS the hiring path: there is no recruiter, no ATS gatekeeper, and a
//   direct note is the single highest-yield thing a candidate can send.
//
//   So "is a CEO useful?" has no fixed answer. It depends on how big the company
//   is. This module makes that judgement explicit and testable instead of
//   leaving every sourced executive to look equally worth emailing.
//
// THE SIZE PROXY, AND ITS LIMITS
//   Nothing in this schema stores headcount. What we DO have, for free and
//   already fetched, is how many roles the company currently has open. That
//   correlates with size well enough for a three-way split, and it is honest
//   about being a proxy: `openRoleCount: null` means unknown, and unknown is
//   treated as small-ish, because the cost of missing a startup founder is
//   losing the best contact available while the cost of over-ranking a big
//   company's CEO is one ignored row.

import type { JobFunction } from '@/lib/jobs/classify'

/** What we know about the role the user is actually pursuing. */
export interface RoleContext {
  /** The job's classified function, when known. */
  jobFunction: JobFunction | null
  /** The job title as posted, used for token overlap. */
  jobTitle: string | null
  /**
   * How many roles this company currently has open — the size proxy. null when
   * unknown, which is treated as "probably small" (see the module header).
   */
  openRoleCount: number | null
}

/**
 * Why a contact is (or is not) worth the user's time on this role.
 *
 * Ordered best-first; `rank()` below relies on this order.
 */
export type ContactBucket =
  /** Owns the requisition: recruiter, talent, people team, named hiring manager. */
  | 'hiring-path'
  /** Would be the user's manager or skip-level in the same function. */
  | 'hiring-manager'
  /** A founder/exec at a company small enough that they do the hiring. */
  | 'founder-small-co'
  /** Would be a peer on the team — a realistic referral. */
  | 'future-teammate'
  /** A real person, but not connected to this role. */
  | 'peripheral'

export interface RelevanceVerdict {
  bucket: ContactBucket
  /** 0..1, for ordering within and across buckets. */
  score: number
  /** Shown to the user so the ranking is never a black box. */
  reason: string
}

/**
 * At or below this many open roles, a company is treated as small enough that
 * its founders and executives are a genuine hiring path rather than noise.
 *
 * Chosen because a company posting more than ~15 roles at once almost certainly
 * has dedicated recruiters, which is the actual thing being tested — not
 * headcount as such, but whether a gatekeeper exists between the candidate and
 * the decision-maker.
 */
export const SMALL_COMPANY_ROLE_CEILING = 15

const RECRUITING_RE =
  /\b(recruit(?:er|ing|ment)?|talent|sourcer|people\s*(?:ops|operations|team|partner)?|hr\b|human\s+resources|staffing|hiring)\b/i

const HIRING_MANAGER_RE = /\b(hiring\s+manager)\b/i

const EXEC_RE =
  /\b(founder|co-?founder|ceo|cto|coo|cfo|cpo|cmo|chief\s+\w+\s+officer|president|owner|partner)\b/i

const LEADERSHIP_RE =
  /\b(head\s+of|vp\b|vice\s+president|director|manager|lead\b|principal|staff)\b/i

/** Words that signal each function, for matching a contact's title to the role. */
const FUNCTION_WORDS: Record<JobFunction, RegExp> = {
  engineering: /\b(engineer|engineering|developer|software|platform|infrastructure|backend|frontend|full-?stack|devops|sre|architect)\b/i,
  data: /\b(data|analytics|analyst|machine\s+learning|ml\b|ai\b|scientist|research)\b/i,
  product: /\b(product|pm\b|program\s+manager)\b/i,
  design: /\b(design|designer|ux|ui\b|research(?:er)?|brand|creative)\b/i,
  sales: /\b(sales|account\s+(?:executive|manager)|revenue|business\s+development|bd\b|partnerships)\b/i,
  marketing: /\b(marketing|growth|demand\s+gen|content|seo|communications|pr\b)\b/i,
  support: /\b(support|customer\s+(?:success|experience|service)|solutions\s+engineer)\b/i,
  operations: /\b(operations|ops\b|supply|logistics|program|project\s+manager)\b/i,
  finance: /\b(finance|financial|accounting|controller|treasury|fp&a)\b/i,
  hr: /\b(hr\b|human\s+resources|people|talent|recruit)\b/i,
  legal: /\b(legal|counsel|compliance|privacy|paralegal)\b/i,
  other: /$^/,
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'at', 'with', 'on',
  'senior', 'staff', 'principal', 'junior', 'lead', 'i', 'ii', 'iii', 'sr', 'jr',
  'remote', 'hybrid', 'onsite', 'contract', 'fulltime', 'full', 'time', 'm', 'w', 'd',
])

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Fraction of the job title's meaningful words that also appear in the contact's title. */
function titleOverlap(contactTitle: string, jobTitle: string): number {
  const want = new Set(tokens(jobTitle))
  if (want.size === 0) return 0
  const have = new Set(tokens(contactTitle))
  let hit = 0
  for (const w of want) if (have.has(w)) hit++
  return hit / want.size
}

/** True when this company is small enough that its founders do their own hiring. */
export function isSmallCompany(openRoleCount: number | null): boolean {
  // Unknown counts as small on purpose — see the module header.
  if (openRoleCount === null || !Number.isFinite(openRoleCount)) return true
  return openRoleCount <= SMALL_COMPANY_ROLE_CEILING
}

/**
 * Rate one sourced contact against the role the user is pursuing.
 *
 * Deliberately returns a REASON alongside the score: the whole point is that a
 * founder ranking first at a startup and last at a megacorp should be legible,
 * not mysterious.
 */
export function scoreContactRelevance(
  contact: { name: string | null; title: string | null },
  role: RoleContext
): RelevanceVerdict {
  const title = (contact.title || '').trim()
  const small = isSmallCompany(role.openRoleCount)
  const sizeNote =
    role.openRoleCount === null
      ? 'company size unknown'
      : `${role.openRoleCount} open role${role.openRoleCount === 1 ? '' : 's'}`

  if (!title) {
    return {
      bucket: 'peripheral',
      score: 0.1,
      reason: 'no title found, so their connection to this role is unknown',
    }
  }

  // 1. Whoever owns the requisition beats everyone, at any company size.
  if (HIRING_MANAGER_RE.test(title)) {
    return { bucket: 'hiring-path', score: 0.98, reason: 'named as a hiring manager' }
  }
  if (RECRUITING_RE.test(title)) {
    return {
      bucket: 'hiring-path',
      score: 0.95,
      reason: 'recruiting or people team — owns roles like this one',
    }
  }

  const fnRe = role.jobFunction ? FUNCTION_WORDS[role.jobFunction] : null
  const sameFunction = fnRe ? fnRe.test(title) : false
  const overlap = role.jobTitle ? titleOverlap(title, role.jobTitle) : 0
  const isExec = EXEC_RE.test(title)
  const isLeader = LEADERSHIP_RE.test(title)

  // 2. An executive is either the hiring path or noise, depending ENTIRELY on
  //    whether this company is small enough to lack a recruiter.
  if (isExec) {
    if (small) {
      return {
        bucket: 'founder-small-co',
        score: 0.9,
        reason: `founder or exec at a small company (${sizeNote}) — likely hires directly`,
      }
    }
    return {
      bucket: 'peripheral',
      score: 0.15,
      reason: `executive at a large company (${sizeNote}) — a cold note will not reach them`,
    }
  }

  // 3. A leader in the same function is the probable hiring manager.
  if (isLeader && (sameFunction || overlap >= 0.34)) {
    return {
      bucket: 'hiring-manager',
      score: 0.85,
      reason: 'leads the function this role sits in — likely the hiring manager',
    }
  }

  // 4. Same function, individual contributor: a realistic referral.
  if (sameFunction || overlap >= 0.34) {
    return {
      bucket: 'future-teammate',
      score: 0.6,
      reason: 'works in the same function — well placed to refer you',
    }
  }

  // 5. A leader somewhere else in the business.
  if (isLeader) {
    return {
      bucket: 'peripheral',
      score: 0.3,
      reason: 'a leader, but in a different function to this role',
    }
  }

  return {
    bucket: 'peripheral',
    score: 0.2,
    reason: 'no visible connection to this role',
  }
}

export const BUCKET_ORDER: readonly ContactBucket[] = [
  'hiring-path',
  'hiring-manager',
  'founder-small-co',
  'future-teammate',
  'peripheral',
]

/**
 * The heading a bucket gets when contacts are grouped for display.
 *
 * These live beside the scoring rules rather than in the panel because the
 * heading and each row's `reason` have to tell ONE story: "Hires directly at
 * this size" over a row reading "founder or exec at a small company (4 open
 * roles) — likely hires directly" is legible. Two independently-worded copies
 * of the same claim drift apart on the first edit to either one.
 */
export const BUCKET_LABELS: Record<ContactBucket, string> = {
  'hiring-path': 'Owns roles like this one',
  'hiring-manager': 'Probably the hiring manager',
  'founder-small-co': 'Small enough to hire directly',
  'future-teammate': 'Would be on your team',
  peripheral: 'Unlikely to move this application',
}

/**
 * Buckets a UI may lead with — i.e. where "top of the list" also means "worth
 * your time". `peripheral` and `future-teammate` are deliberately excluded:
 * when a big company's page yields nothing but executives, the best-ranked
 * group is still a group of people who will not answer, and highlighting it
 * would re-tell exactly the lie this module exists to stop.
 */
const LEADABLE_BUCKETS: readonly ContactBucket[] = ['hiring-path', 'hiring-manager', 'founder-small-co']

export function isLeadableBucket(bucket: ContactBucket): boolean {
  return LEADABLE_BUCKETS.includes(bucket)
}

export interface RankedGroup<T> {
  bucket: ContactBucket
  label: string
  contacts: T[]
}

/**
 * Split an already-ranked list into display groups, best bucket first, empty
 * buckets omitted. Grouping is what makes the useful people unmissable — a
 * flat sorted list buries the distinction between "the recruiter who owns this
 * req" and "the fourth-best person we could find".
 */
export function groupRankedContacts<T extends { relevance: RelevanceVerdict }>(
  ranked: readonly T[]
): RankedGroup<T>[] {
  return BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    contacts: ranked.filter((c) => c.relevance.bucket === bucket),
  })).filter((group) => group.contacts.length > 0)
}

/**
 * Order contacts best-first for a role, annotating each with why.
 *
 * Sorts by bucket then score, so a recruiter always outranks a founder even
 * when both score highly — the recruiter can actually move the application.
 */
export function rankContactsForRole<T extends { name: string | null; title: string | null }>(
  contacts: readonly T[],
  role: RoleContext
): (T & { relevance: RelevanceVerdict })[] {
  return contacts
    .map((c) => ({ ...c, relevance: scoreContactRelevance(c, role) }))
    .sort((a, b) => {
      const byBucket =
        BUCKET_ORDER.indexOf(a.relevance.bucket) - BUCKET_ORDER.indexOf(b.relevance.bucket)
      if (byBucket !== 0) return byBucket
      return b.relevance.score - a.relevance.score
    })
}
