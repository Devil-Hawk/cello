// The measure ids a command may name (blueprint 13.1): the ids of K7's register
// (T are true numbers, S step sets, P person measures).

import { REGISTER } from '@/lib/measures/register'

export const MEASURE_IDS: readonly string[] = REGISTER.map((m) => m.id)

export function isMeasureId(id: string): boolean {
  return MEASURE_IDS.includes(id)
}

/** What a command writes in `measure` when it is a plain record edit that the
 *  list in no-measure.ts names. */
export const NO_MEASURE = 'none'
