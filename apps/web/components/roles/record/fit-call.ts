// The two calls the record makes about fit: check this one role now (POST /api/roles/:id/fit, which
// K8a built and the old Jobs page was the only caller of), and send a correction to a requirement.

import type { FitVerdict } from '@/lib/fit/types'
import type { RoleFit } from '@/lib/scoring/types'

/** `stop` is set when the route refused for a reason that holds for every role (no model, no resume, budget), so a loop over many roles should end. */
export type CheckResult = { ok: true; fit: RoleFit } | { ok: false; message: string; stop?: boolean }

/** Checks the person's chance for one role. The words of a refusal (no resume, no model) come from the route. */
export async function checkChance(jobId: string): Promise<CheckResult> {
  try {
    const res = await fetch(`/api/roles/${jobId}/fit`, { method: 'POST' })
    const body = (await res.json().catch(() => null)) as (RoleFit & { error?: string; skippedReason?: string }) | null
    if (!res.ok || !body) return { ok: false, message: body?.error ?? 'Could not check your chance. Try again.', stop: !!body?.skippedReason }
    return { ok: true, fit: body }
  } catch {
    return { ok: false, message: 'Could not check your chance. Try again.' }
  }
}

/** Sends the person's own verdict on one requirement to the route that stores it. True when it was stored. */
export async function sendCorrection(url: string, requirementId: string, verdict: FitVerdict, note: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requirementId, verdict, note: note.trim() || null }) })
    return res.ok
  } catch {
    return false
  }
}
