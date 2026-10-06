// Check chances for all: the roles the person keeps and Cello has not checked, checked 12 at a time
// through the same route the record uses for one role. Stop ends the loop at once (the calls already
// out finish); a refusal that holds for every role (no model, no resume, budget) ends it too.

import type { CheckResult } from './record/fit-call'

export const BATCH = 12

export interface CheckAllResult {
  checked: number
  total: number
  /** The route's words when it refused the whole loop. */
  refusal: string | null
}

export async function checkAll(
  ids: readonly string[],
  check: (id: string) => Promise<CheckResult>,
  opts: { stopped: () => boolean; onProgress?: (checked: number) => void },
): Promise<CheckAllResult> {
  let next = 0
  let checked = 0
  let refusal: string | null = null
  const worker = async () => {
    while (!opts.stopped() && refusal === null && next < ids.length) {
      const r = await check(ids[next++])
      if (r.ok) checked++
      else if (r.stop) refusal = r.message
      opts.onProgress?.(checked)
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH, ids.length) }, worker))
  return { checked, total: ids.length, refusal }
}

/** "Checked 24 of 61." and, when the route refused, its words after it. */
export function checkAllLine(r: CheckAllResult): string {
  return `Checked ${r.checked} of ${r.total}.${r.refusal ? ` ${r.refusal}` : ''}`
}
