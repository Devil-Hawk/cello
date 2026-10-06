// What each count becomes, by code. A closed table: the question or reason names the
// kind and effect, a fixed template builds the statement, and `params` are chosen here
// from the counted group. A model writes none of it (directive 20).

import type { QuestionResult, StrategyReport, OutcomeBucket } from '../strategy/types'
import type { PassReason } from '../scoring/types'
import type { CountInput } from './store'

/** Fewest passes with one reason before it is stated (blueprint 9). */
export const MIN_PASSES_PER_REASON = 5

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const bucketsOf = <T extends { buckets: OutcomeBucket[] }>(r: QuestionResult<T>): OutcomeBucket[] => (r.status === 'answered' ? r.data.buckets : [])

/** One bucket of replies, stated by a fixed template per question. Thin buckets are not stated. */
function bucketCounts(question: string, kind: CountInput['kind'], effect: CountInput['effect'], buckets: OutcomeBucket[], phrase: (b: OutcomeBucket) => string): CountInput[] {
  return buckets
    .filter((b) => !b.thinBucket)
    .map((b) => ({
      key: `${kind}:${question}:${slug(b.label)}`,
      kind,
      effect,
      params: { group: b.label, replies: b.replies, applications: b.applications },
      statement: `${b.replies} of ${plural(b.applications, 'application')} ${phrase(b)}`,
      n: b.applications,
    }))
}

/**
 * Every answered question of the strategy report as count learnings. The questions
 * already refuse to answer below their thresholds, so nothing below one is stated.
 */
export function outcomeCounts(report: StrategyReport): CountInput[] {
  const out: CountInput[] = []
  out.push(...bucketCounts('sourceFunnel', 'outcome', 'rank.fresh', bucketsOf(report.sourceFunnel), (b) => `from ${b.label} got a reply`))
  out.push(...bucketCounts('applicationTiming', 'timing', 'rank.fresh', bucketsOf(report.applicationTiming), (b) => `sent ${b.label} after posting got a reply`))
  out.push(...bucketCounts('resumeVariants', 'resume', 'resume.version', bucketsOf(report.resumeVariants), (b) => `with ${b.label} got a reply`))
  out.push(...bucketCounts('outreachImpact', 'outcome', 'prepare.order', bucketsOf(report.outreachImpact), (b) => `${b.label.toLowerCase()} got a reply`))
  if (report.rejectionPatterns.status === 'answered') {
    for (const g of report.rejectionPatterns.data.groups) {
      out.push({
        key: `rejection:${g.kind}:${slug(g.key)}`,
        kind: 'rejection',
        effect: 'search.propose',
        params: { group: g.key, dimension: g.kind, rejected: g.rejected, applications: g.totalApplications },
        statement: `${g.rejected} of ${plural(g.totalApplications, 'application')} in ${g.key} were rejected`,
        n: g.totalApplications,
      })
    }
  }
  return out
}

const PASS_REASON_TEXT: Record<PassReason, string> = {
  too_junior: 'the role was too junior',
  too_senior: 'the role was too senior',
  company: 'the company',
  domain: 'the kind of work',
  location: 'the location',
  relocation: 'relocation',
  agency: 'an agency posting',
  sponsorship: 'sponsorship',
  pay: 'the pay',
  other: 'another reason',
}

export interface ReactionCount {
  reaction: string
  reason: string | null
  surface: string
}

/** "7 of 9 passes said relocation": a count per reason that has at least five passes. */
export function passReasonCounts(reactions: readonly ReactionCount[]): CountInput[] {
  const passes = reactions.filter((r) => r.reaction === 'not_for_me')
  const withReason = passes.filter((r) => r.reason && r.reason in PASS_REASON_TEXT)
  const byReason = new Map<string, number>()
  for (const p of withReason) byReason.set(p.reason as string, (byReason.get(p.reason as string) ?? 0) + 1)
  return [...byReason.entries()]
    .filter(([, k]) => k >= MIN_PASSES_PER_REASON)
    .map(([reason, k]) => ({
      key: `pass:${reason}`,
      kind: 'taste' as const,
      effect: 'rank.want' as const,
      params: { reason },
      statement: `${k} of ${plural(withReason.length, 'pass', 'passes')} with a reason said ${PASS_REASON_TEXT[reason as PassReason]}`,
      n: k,
    }))
}

/** `taste:blend`: the count learning that lets history order roles. Both counts are in its statement. */
export function tasteBlendCount(reactions: readonly ReactionCount[]): CountInput | null {
  const applications = reactions.filter((r) => r.surface === 'applications').length
  const rest = reactions.length - applications
  if (reactions.length === 0) return null
  return {
    key: 'taste:blend',
    kind: 'taste',
    effect: 'rank.want',
    params: {},
    statement: `Your ${plural(applications, 'past application')} and ${plural(rest, 'reaction')} order your roles`,
    n: reactions.length,
  }
}
