// The summary: what happened overnight and what waits, in plain sentences, from the events and the
// Needs you count. One function, so the daily email, Today's "since you were last here" and the push
// say the same thing. A send that was not confirmed is never called sent.

export interface SummaryEvent {
  kind: string
  actor: string
  trust: string
  company_name: string | null
}

export interface SummaryInput {
  events: readonly SummaryEvent[]
  needsYouCount: number
  paused: boolean
}

export interface Summary {
  subject: string
  lines: string[]
  /** Nothing happened and nothing waits: no email is sent. */
  empty: boolean
}

const MAX_LINES = 6

function names(events: readonly SummaryEvent[]): string {
  const uniq = [...new Set(events.map((e) => e.company_name).filter((n): n is string => Boolean(n)))]
  if (uniq.length === 0) return ''
  const shown = uniq.slice(0, 3).join(', ')
  return uniq.length > 3 ? `${shown} and ${uniq.length - 3} more` : shown
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function buildSummary(i: SummaryInput): Summary {
  const by = (kind: string, actor?: string) => i.events.filter((e) => e.kind === kind && (!actor || e.actor === actor))
  const sentAuto = by('submission.sent', 'extension').filter((e) => e.trust !== 'unconfirmed')
  const unconfirmed = [...by('submission.unconfirmed'), ...by('submission.sent', 'extension').filter((e) => e.trust === 'unconfirmed')]
  const stops = by('fill.blocked')
  const started = by('application.created', 'rule')
  const replies = by('message.received').filter((e) => e.trust !== 'unconfirmed')

  const lines: string[] = []
  if (sentAuto.length) lines.push(`Cello sent ${plural(sentAuto.length, 'application', 'applications')} from your browser: ${names(sentAuto)}.`.replace(/: \.$/, '.'))
  if (unconfirmed.length) lines.push(`${plural(unconfirmed.length, 'application', 'applications')} could not be confirmed${names(unconfirmed) ? `: ${names(unconfirmed)}` : ''}. Check ${unconfirmed.length === 1 ? 'it' : 'them'}; Cello does not count ${unconfirmed.length === 1 ? 'it' : 'them'} as sent.`)
  if (stops.length) lines.push(`${plural(stops.length, 'application', 'applications')} stopped on the site and ${stops.length === 1 ? 'waits' : 'wait'} for you${names(stops) ? `: ${names(stops)}` : ''}.`)
  if (started.length) lines.push(`Your rule started ${plural(started.length, 'application', 'applications')}.`)
  if (replies.length) lines.push(`${plural(replies.length, 'reply', 'replies')} from employers${names(replies) ? `: ${names(replies)}` : ''}.`)
  if (i.needsYouCount > 0) lines.push(`${i.needsYouCount === 1 ? '1 thing needs' : `${i.needsYouCount} things need`} you.`)
  if (i.paused) lines.push('Cello is paused, so nothing is being prepared or sent.')

  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `And ${lines.length - (MAX_LINES - 1)} more updates in Cello.`] : lines
  const empty = lines.length === 0 || (lines.length === 1 && i.paused)
  return {
    subject: empty ? 'Nothing new in Cello' : i.needsYouCount > 0 ? `${i.needsYouCount === 1 ? '1 thing needs' : `${i.needsYouCount} things need`} you in Cello` : 'Your Cello summary',
    lines: empty ? ['Nothing new since yesterday.'] : shown,
    empty,
  }
}
