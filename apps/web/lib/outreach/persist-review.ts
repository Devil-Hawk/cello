// Store the outcome of reviewing one outreach draft as eval_verdicts rows, so
// the card can show what was checked, what failed and why, and so a draft that
// was not checked never looks like one that was. Used by the draft and
// follow-up routes. Best effort: writeVerdict logs and never throws.

import { writeVerdict } from '@/lib/evals/verdicts'
import type { AdminClient } from '@/lib/harness/types'
import type { OutreachReview } from '@/lib/graph/verify/outreach'

const JUDGES = ['groundedness', 'specificity'] as const

export function unjudgedReason(review: Pick<OutreachReview, 'judgeRefused' | 'judgeUnavailable'>): string | null {
  if (review.judgeRefused === 'missing-key') return 'Not checked: no OpenRouter key is set.'
  if (review.judgeRefused === 'budget-cap') return 'Not checked: the spending cap is reached.'
  if (review.judgeUnavailable) return 'Not checked: the check could not run. Check again in a few minutes.'
  return null
}

export async function writeReviewVerdicts(admin: AdminClient, userId: string, messageId: string, review: OutreachReview): Promise<void> {
  const base = { userId, subjectKind: 'outreach_draft' as const, subjectId: messageId }

  for (const v of review.verdicts) {
    await writeVerdict(admin, {
      ...base,
      judge: v.name === 'specificity' ? 'specificity' : 'groundedness',
      verdict: v.verdict,
      score: v.score,
      threshold: v.threshold,
      rationale: v.summary,
      judgeSpanId: v.spanId,
    })
  }

  const why = unjudgedReason(review)
  if (why) {
    for (const judge of JUDGES) await writeVerdict(admin, { ...base, judge, verdict: 'unjudged', rationale: why })
  }

  const failed = review.checks.checks.filter((c) => !c.ok)
  await writeVerdict(admin, {
    ...base,
    judge: 'deterministic',
    verdict: failed.length === 0 ? 'pass' : 'fail',
    score: (review.checks.checks.length - failed.length) / Math.max(1, review.checks.checks.length),
    threshold: 1,
    rationale: failed.length === 0 ? 'All checks passed' : failed.map((c) => c.message).join(' '),
  })
}
