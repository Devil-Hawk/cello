'use server'

// Saves a person's correction of a fact Cello read from their resume (the headline, the years).
// The value is stored as theirs under profiles.preferences.facts[key] and wins on the next read.
// It runs on the server because the browser never reads profiles.preferences whole: that column
// also holds the encrypted API keys (lib/preferences/client-safe.ts).

import { z } from 'zod'
import type { Json } from '@cello/shared'
import { createClient } from '@/lib/supabase/server'

const Correction = z.object({ field: z.enum(['headline', 'years']), value: z.string().trim().min(1).max(200) })

export async function saveFact(field: string, value: string): Promise<{ ok: boolean }> {
  const parsed = Correction.safeParse({ field, value })
  if (!parsed.success) return { ok: false }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false }

  const { data: profile, error } = await supabase.from('profiles').select('preferences').eq('id', user.id).maybeSingle()
  if (error) return { ok: false }
  const preferences = (profile?.preferences && typeof profile.preferences === 'object' ? profile.preferences : {}) as Record<string, unknown>
  const facts = (preferences.facts && typeof preferences.facts === 'object' ? preferences.facts : {}) as Record<string, unknown>

  // ponytail: read-modify-write as the constraints route does; one rpc with jsonb_set if two tabs ever race
  const next = {
    ...preferences,
    facts: { ...facts, [parsed.data.field]: { value: parsed.data.value, origin: 'person', prov: { door: 'session' }, at: new Date().toISOString() } },
  }
  const { error: writeError } = await supabase
    .from('profiles')
    .update({ preferences: next as unknown as Json })
    .eq('id', user.id)
  return { ok: !writeError }
}
