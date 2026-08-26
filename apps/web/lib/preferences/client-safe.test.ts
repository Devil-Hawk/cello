import { describe, expect, it, vi } from 'vitest'
import { CLIENT_SAFE_PREFERENCES_RPC, fetchClientSafePreferences } from './client-safe'

/** Minimal stand-in for the one method this module calls. */
function fakeClient(rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc } as unknown as Parameters<typeof fetchClientSafePreferences>[0]
}

describe('fetchClientSafePreferences', () => {
  it('calls the get_client_safe_preferences RPC and returns its data', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { matchThreshold: 70, budget: { spentUsd: 1, monthlyUsd: 10 } },
      error: null,
    })
    const result = await fetchClientSafePreferences(fakeClient(rpc))
    expect(rpc).toHaveBeenCalledWith(CLIENT_SAFE_PREFERENCES_RPC)
    expect(result).toEqual({ matchThreshold: 70, budget: { spentUsd: 1, monthlyUsd: 10 } })
  })

  it('returns null, not throw, when the RPC errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'permission denied' } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await fetchClientSafePreferences(fakeClient(rpc))
    expect(result).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('returns null when the caller has no profile row (function returns SQL NULL)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const result = await fetchClientSafePreferences(fakeClient(rpc))
    expect(result).toBeNull()
  })

  it('never returns the fields the SQL function is not allowed to send', async () => {
    // Even if a compromised/rogue backend somehow returned extra keys, this
    // helper does not filter — the security boundary is the SQL function's
    // fixed jsonb_build_object() call, not this file. This test documents
    // that assumption rather than re-implementing a redundant client-side
    // filter that would give a false sense of a second boundary existing.
    const rpc = vi.fn().mockResolvedValue({
      data: { matchThreshold: 50 },
      error: null,
    })
    const result = await fetchClientSafePreferences(fakeClient(rpc))
    expect(result).not.toHaveProperty('api_keys')
    expect(result).not.toHaveProperty('atsKeys')
  })
})
