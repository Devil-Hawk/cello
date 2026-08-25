// Service-role Supabase client for harness server-side writes.
//
// The harness journals steps into agent_steps, which has an RLS SELECT policy
// but NO insert/update policy — so writes MUST use the service role (bypasses
// RLS), exactly like scripts/ats-refresh.ts. This client is intentionally
// UNtyped (no Database generic) because agent_runs/agent_steps/application_drafts
// are not in @cello/shared's generated Database type; row shapes live in ./types.
//
// Never import this from client components — it holds the service-role key.

import { createClient } from '@supabase/supabase-js'
import type { AdminClient } from './types'

let cached: AdminClient | null = null

export function createAdminClient(): AdminClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

  if (!url) throw new Error('Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL')
  if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

  cached = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return cached
}
