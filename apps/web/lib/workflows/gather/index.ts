// The Writer's gather step: what it may read about the person, from the person's own record only.
//
//   - the base resume (its newest version, else the text mirrored on the profile)
//   - the profile facts: the name the draft is signed with
//   - the person's saved answers (the stub until K16's answer_bank is on main)
//   - the writing preferences the person kept (`draft.style` learnings), as a quoted block
//   - what Cello remembers about the contact, once K26 fills gather/network.ts
//
// Each source is data. Nothing here reads a posting or an email: the Writer frames those itself.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminClient } from '@/lib/harness/types'
import { readLearnings } from '@/lib/learning/read'
import { formatKeptBlock } from '@/lib/learning/store'
import { getBaseResume } from '@/lib/resume/store'
import { savedAnswers, type SavedAnswer } from '../answers'
import { gatherNetwork, type NetworkLine } from './network'

export interface Gathered {
  resumeText: string
  /** The base resume version the text came from, null when only the profile mirror was there. */
  baseResume: { id: string; version: number } | null
  userName: string | null
  answers: SavedAnswer[]
  /** The kept `draft.style` learnings as a quoted block, '' when none or when mem0 could not be read. */
  style: string
  network: NetworkLine[]
}

export async function gatherSources(admin: AdminClient, userId: string, opts: { contactId?: string | null } = {}): Promise<Gathered> {
  const base = await getBaseResume(admin as unknown as SupabaseClient, userId).catch(() => null)
  const { data: profile } = await admin.from('profiles').select('full_name, resume_text').eq('id', userId).maybeSingle()
  const p = (profile ?? {}) as { full_name?: string | null; resume_text?: string | null }
  const learned = await readLearnings(userId, 'active')
  return {
    resumeText: (base?.content ?? p.resume_text ?? '').trim(),
    baseResume: base ? { id: base.id, version: base.version } : null,
    userName: p.full_name?.trim() || null,
    answers: await savedAnswers(userId),
    style: learned.ok ? formatKeptBlock(learned.items.filter((l) => l.effect === 'draft.style')) : '',
    network: await gatherNetwork(userId, opts.contactId),
  }
}
