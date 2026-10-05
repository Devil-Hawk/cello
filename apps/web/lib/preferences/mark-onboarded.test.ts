import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { markOnboarded, SET_ONBOARDING_PREFERENCES_RPC } from './client-safe'

function clientWith(result: { error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result)
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

describe('markOnboarded (Skip for now persistence)', () => {
  it('stamps onboarding through the narrow RPC, passing the current threshold through', async () => {
    const { client, rpc } = clientWith({ error: null })
    expect(await markOnboarded(client, 85)).toBeNull()
    expect(rpc).toHaveBeenCalledWith(SET_ONBOARDING_PREFERENCES_RPC, { p_match_threshold: 85 })
  })

  it('surfaces an RPC failure instead of pretending the skip was saved', async () => {
    const { client } = clientWith({ error: { message: 'boom' } })
    expect(await markOnboarded(client, 70)).toEqual({ message: 'boom' })
  })
})
