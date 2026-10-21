// One route_timings row per call of a Companies route: the measure S1's numbers (lib/measures/register.ts, T37).
// Written with the service role. A timing that cannot be written is lost, and the request it measured still answers.

import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient<any, any, any>

export async function recordRouteTiming(db: () => Db, route: string, ms: number, ok: boolean): Promise<void> {
  try {
    await db().from('route_timings').insert({ route, ms, ok })
  } catch {
    // never fail the request over its timing
  }
}
