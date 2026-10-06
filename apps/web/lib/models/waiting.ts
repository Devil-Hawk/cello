// What happens when the free models run out for the day (blueprint 11.3).
//
// OpenRouter answers 429 with "free-models-per-day" once a free key has used its
// day, counted per UTC day, and 402 when the balance is below zero, which blocks
// free models too. Neither is retried. The call throws one of these errors, and
// whoever started the work (the pipeline's advancer, K13) parks it in Waiting
// with the sentence below, in the order below.

/** Both carry the HTTP status, so the spend ledger records the call as a limit hit. */
export class FreeLimitReachedError extends Error {
  readonly status = 429
  constructor(readonly resetAt: Date) {
    super('The free model limit for today was reached.')
    this.name = 'FreeLimitReachedError'
  }
}

export class NegativeBalanceError extends Error {
  readonly status = 402
  constructor() {
    super('Your OpenRouter balance is below zero, which blocks free models too. Add credit or choose another way to run.')
    this.name = 'NegativeBalanceError'
  }
}

/** OpenRouter counts free requests per UTC day, so the limit lifts at the next UTC midnight. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

/** The work that waits for the reset, first to last: mail reading and drafts the person
 *  asked for, applications they started, the morning pick, then preparation a rule started.
 *  Chat is never queued. */
export const WAIT_ORDER = ['mail', 'asked_draft', 'started_application', 'morning_pick', 'rule_preparation'] as const
export type WaitKind = (typeof WAIT_ORDER)[number]

/** Waiting work in the order it should resume: by kind, then oldest request first. Stable. */
export function orderWaiting<T extends { kind: WaitKind; askedAt: string | number | Date }>(items: readonly T[]): T[] {
  const at = (t: T) => new Date(t.askedAt).getTime()
  return [...items].sort((a, b) => WAIT_ORDER.indexOf(a.kind) - WAIT_ORDER.indexOf(b.kind) || at(a) - at(b))
}

const clock = (d: Date, zone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)

/** "Cello reached today's free model limit at 14:10. Drafting and preparing continue at 20:00 your time." */
export function limitSentence(reachedAt: Date, resetAt: Date, zone: string): string {
  return `Cello reached today's free model limit at ${clock(reachedAt, zone)}. Drafting and preparing continue at ${clock(resetAt, zone)} your time.`
}
