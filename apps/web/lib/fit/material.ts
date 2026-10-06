// What a requirement is read against: the person's own words, and nothing else (K17b).
//
//   resume    the base resume's newest version (the profile's mirrored text when there is no version)
//   answers   the saved answers they gave (K16's answer_bank; none until it is on main)
//   facts     profile facts with origin = 'person' (arrive with K16; none until then)
//   material  the Your material they allow (K23; none until then)
//
// Every source carries the id of the stored record it came from, because a quote is only kept when it
// is found, word for word, in the record it names. Another person's material is never loaded: every
// read here is scoped to the person.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminClient } from '@/lib/harness/types'
import { getBaseResume } from '@/lib/resume/store'
import { savedAnswers } from '@/lib/workflows/answers'
import type { EvidenceSource } from './types'

export interface MaterialSource {
  source: EvidenceSource
  /** The stored record: a resume version id, an answer id, a profile fact id, a material chunk id. */
  ref: string
  text: string
  /** When the record last changed, an ISO string, '' when not known. It is part of the material key. */
  updatedAt: string
}

export interface Material {
  /** Every source, in the order a hit is looked for. */
  sources: MaterialSource[]
  /** The base resume version the resume source came from, null when only the profile mirror was there. */
  baseResume: { id: string; version: number } | null
}

export const PROFILE_RESUME_REF = 'profile:resume_text'

export async function loadMaterial(admin: AdminClient, userId: string): Promise<Material> {
  const sources: MaterialSource[] = []
  const base = await getBaseResume(admin as unknown as SupabaseClient, userId).catch(() => null)
  if (base) sources.push({ source: 'resume', ref: base.id, text: base.content, updatedAt: base.created_at })
  else {
    const { data } = await admin.from('profiles').select('resume_text, updated_at').eq('id', userId).maybeSingle()
    const p = data as { resume_text?: string | null; updated_at?: string | null } | null
    if (p?.resume_text?.trim()) sources.push({ source: 'resume', ref: PROFILE_RESUME_REF, text: p.resume_text, updatedAt: p.updated_at ?? '' })
  }
  for (const a of await savedAnswers(userId)) sources.push({ source: 'answer', ref: a.id, text: `${a.question}\n${a.answer}`, updatedAt: a.updated_at })
  return { sources, baseResume: base ? { id: base.id, version: base.version } : null }
}

/**
 * A hash of what the person's material was: the base resume version, each answer and fact and when it last
 * changed. A verdict made against one key is stale against another, and only then.
 */
export function materialKey(m: Material): string {
  const parts = m.sources.map((s) => `${s.source}:${s.ref}:${s.updatedAt}`).sort()
  return createHash('sha256').update(JSON.stringify([m.baseResume ? [m.baseResume.id, m.baseResume.version] : null, parts])).digest('hex').slice(0, 32)
}
