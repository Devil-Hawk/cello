// Saves a correction where the fact lives. The browser reads and writes only what each home allows:
// the profile name directly, the stated constraints and the targeting through their routes (which
// check them), and the headline and years through a server action.

import { saveFact } from '@/app/(app)/profile/actions'
import { createClient } from '@/lib/supabase/client'
import { parseCorrection, type Fact } from './facts'

const ROUTE = { constraints: '/api/settings/constraints', targeting: '/api/settings/targeting' } as const
const FAILED = 'Could not save that. Your value is unchanged.'

/** Returns what went wrong, or null when the correction was saved. */
export async function correctFact(fact: Fact, raw: string): Promise<string | null> {
  if (!fact.correct) return FAILED
  const { home, field, input } = fact.correct
  const parsed = parseCorrection(field, input, raw)
  if (!parsed.ok) return parsed.error
  try {
    if (home === 'profile') {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return FAILED
      const { error } = await supabase.from('profiles').update({ full_name: String(parsed.value) }).eq('id', user.id)
      return error ? FAILED : null
    }
    if (home === 'facts') return (await saveFact(field, String(parsed.value))).ok ? null : FAILED

    // Constraints and targeting are saved whole: read the current ones, change the one field, put them back.
    const current = await fetch(ROUTE[home])
    const body = (await current.json().catch(() => null)) as Record<string, Record<string, unknown>> | null
    const existing = body?.[home]
    if (!current.ok || !existing) return FAILED
    const saved = await fetch(ROUTE[home], {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...existing, [field]: parsed.value }),
    })
    if (saved.ok) return null
    const problem = (await saved.json().catch(() => null)) as { error?: string } | null
    return problem?.error ?? FAILED
  } catch {
    return FAILED
  }
}
