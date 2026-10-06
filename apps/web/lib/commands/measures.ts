// The measure ids a command may name (blueprint 13.1): T1 to T33 are true
// numbers, S1 to S26 are step sets, P1 to P9 are person measures.
// If K7's measure seed exports the list at the base, import that instead.

const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

export const MEASURE_IDS: readonly string[] = [...range('T', 33), ...range('S', 26), ...range('P', 9)]

export function isMeasureId(id: string): boolean {
  return MEASURE_IDS.includes(id)
}

/** What a command writes in `measure` when it is a plain record edit that the
 *  list in no-measure.ts names. */
export const NO_MEASURE = 'none'
