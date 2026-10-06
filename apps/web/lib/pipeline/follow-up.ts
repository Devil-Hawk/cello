// The next-step rule for follow-ups: when an application is due a nudge and
// what to say about it. Pure code, no model. The pipeline alert and the
// application follow-up unit both read this one table.

export const FOLLOW_UP_TIMING: Record<string, { min: number; max: number }> = {
  applied: { min: 5, max: 7 }, // 5-7 days after applying
  screen: { min: 3, max: 5 }, // 3-5 days after screen
  interview: { min: 1, max: 2 }, // 1-2 days after interview (thank you)
  offer: { min: 2, max: 3 }, // 2-3 days to respond
}

const DAY_MS = 1000 * 60 * 60 * 24

export function daysSince(date: Date | null, now = Date.now()): number {
  if (!date) return 0
  return Math.floor(Math.abs(now - date.getTime()) / DAY_MS)
}

function timingSuggestion(stage: string, days: number): string {
  const timing = FOLLOW_UP_TIMING[stage]
  if (!timing) return 'No follow-up needed for this stage.'
  const soon = days < timing.min
  switch (stage) {
    case 'applied':
      return soon
        ? `It's only been ${days} days since you applied. Wait until day ${timing.min} to follow up.`
        : `It's been ${days} days since you applied. Consider sending a brief follow up to check on your application status.`
    case 'screen':
      return soon
        ? `It's been ${days} days since your screen. Wait a bit longer before following up.`
        : `It's been ${days} days since your screen. Send a thank you note and reiterate your interest.`
    case 'interview':
      return soon
        ? `It's been ${days} days since your interview. Consider sending a thank you note soon.`
        : `It's been ${days} days since your interview. Send a thank you note and ask about next steps.`
    default:
      return soon
        ? `It's been ${days} days since receiving the offer. Take time to review it carefully.`
        : `It's been ${days} days since receiving the offer. Follow up with any questions about the offer or negotiation.`
  }
}

/** Is a follow-up due for this application, and what is the suggestion.
 *  `appliedAt` is the baseline activity date. */
export function followUpStep(
  stage: string,
  appliedAt: Date | null,
  now = Date.now()
): { due: boolean; days: number; suggestion: string } {
  const days = daysSince(appliedAt, now)
  const timing = FOLLOW_UP_TIMING[stage]
  if (!appliedAt || !timing || days < timing.min) {
    const suggestion = timing
      ? `It's too soon to follow up. Wait until day ${timing.min} since applying (currently day ${days}).`
      : 'No follow-up action needed at this stage.'
    return { due: false, days, suggestion }
  }
  return { due: true, days, suggestion: timingSuggestion(stage, days) }
}
