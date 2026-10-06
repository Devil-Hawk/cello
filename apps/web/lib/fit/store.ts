// role_evidence: what a model judged or the person corrected about one role. Code verdicts are never
// stored. Every read and write names the person: the service client bypasses RLS, so the predicate here
// is the only fence between people.

import type { AdminClient } from '@/lib/harness/types'
import type { FitItem, RoleEvidenceRow } from './types'

const COLUMNS = 'user_id, job_id, items, origin, prov, confirmed_at, desc_md5, material_key, computed_at'

export async function readEvidence(admin: AdminClient, userId: string, jobId: string): Promise<RoleEvidenceRow | null> {
  const { data } = await admin.from('role_evidence').select(COLUMNS).eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  return (data as RoleEvidenceRow | null) ?? null
}

export interface SaveEvidence {
  userId: string
  jobId: string
  items: FitItem[]
  prov: RoleEvidenceRow['prov']
  descMd5: string | null
  materialKey: string
  /** Only a model's reading counts against the daily cap, so the time it was made is kept. */
  computedAt?: string
}

/** Replaces the row for this person and role. The row's origin is `model` while it holds a model verdict. */
export async function saveEvidence(admin: AdminClient, s: SaveEvidence): Promise<void> {
  const origin = s.items.some((i) => i.origin === 'model') ? 'model' : 'person'
  const { error } = await admin.from('role_evidence').upsert(
    {
      user_id: s.userId,
      job_id: s.jobId,
      items: s.items,
      origin,
      prov: s.prov,
      desc_md5: s.descMd5,
      material_key: s.materialKey,
      computed_at: s.computedAt ?? new Date().toISOString(),
    },
    { onConflict: 'user_id,job_id' }
  )
  if (error) throw new Error(`could not save the evidence: ${error.message}`)
}

/** How many roles a model has read for this person since `since` (an ISO time): the daily cap counts these. */
export async function modelReadsSince(admin: AdminClient, userId: string, since: string): Promise<number> {
  const { data } = await admin.from('role_evidence').select('prov, origin').eq('user_id', userId).eq('origin', 'model').gte('computed_at', since).limit(500)
  return ((data as { prov: { step?: string } | null }[] | null) ?? []).filter((r) => r.prov?.step === 'role.evidence').length
}
