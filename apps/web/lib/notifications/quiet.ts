// Quiet hours: when Cello tells the person nothing. The window is in the person's own zone and may
// cross midnight (21:00 to 08:00). Only an offer or an interview invitation breaks it.

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

/** Minutes since local midnight in `zone`. An unknown zone falls back to UTC. */
export function localMinutes(now: Date, zone: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

export function isQuiet(now: Date, zone: string, from: string, to: string): boolean {
  const t = localMinutes(now, zone)
  const a = hhmm(from)
  const b = hhmm(to)
  if (a === b) return false
  return a < b ? t >= a && t < b : t >= a || t < b
}

/** What may be told during quiet hours. */
export const BREAKS_QUIET: readonly string[] = ['offer_due', 'interview']
