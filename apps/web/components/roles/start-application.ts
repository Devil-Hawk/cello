// Apply, from anywhere a role is shown: starts the application (POST /api/applications). Cello prepares it and stops at
// "approve" before anything is sent; nothing here submits to an employer.

export type Started = { ok: true } | { ok: false; sentence: string }

export async function startApplication(jobId: string): Promise<Started> {
  try {
    const res = await fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) })
    const body = (await res.json().catch(() => ({}))) as { error?: string; refusal?: string }
    // "Cello is already working on this one" is a start that already happened: the application is there.
    if (res.ok || body.refusal === 'already') return { ok: true }
    return { ok: false, sentence: body.error ?? 'Could not start that. Try again.' }
  } catch {
    return { ok: false, sentence: 'Could not reach Cello. Try again.' }
  }
}
