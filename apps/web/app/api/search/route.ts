// GET /api/search?q=...&limit=...&freshness=... — Cello's own web_search
// TOOL as an authed HTTP endpoint: the harness/copilot's route onto the open
// internet, not just the 3 ATS adapters + 11 keyless aggregators (see
// docs/PRODUCT-VISION.md, "Sourcing"). Backend is resolved per user by
// webSearch() itself (opts.userId): it runs its own failover CHAIN — every
// BYOK backend the user has configured (tavily/serper/exa), then a
// configured SearXNG instance, then the free keyless DuckDuckGo scrape as
// the last resort — see lib/search/index.ts for the client this route is a
// thin wrapper over, and Settings → Search for where those keys are managed.
//
// Rate-limited in-process (lib/search/rate-limit.ts): DuckDuckGo is free but
// shared, the others are metered, so this must not be callable in an
// unbounded loop. Mirrors the GET /api/kb/search route's shape (auth -> parse
// params -> call the pure client -> normalize the JSON envelope).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { webSearch } from '@/lib/search'
import { allowSearchRequest } from '@/lib/search/rate-limit'
import type { WebSearchOptions } from '@/lib/search/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

const VALID_FRESHNESS = new Set(['day', 'week', 'month', 'year'])
const VALID_BACKENDS = new Set(['duckduckgo', 'exa', 'tavily', 'serper', 'searxng'])

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!allowSearchRequest(user.id)) {
    return NextResponse.json({ error: 'Too many searches — wait a moment and try again.' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const query = (searchParams.get('q') || '').trim()
  if (!query) return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 })

  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Math.min(25, Math.max(1, parseInt(limitParam, 10) || 10)) : undefined

  const freshnessParam = searchParams.get('freshness') ?? ''
  const freshness = VALID_FRESHNESS.has(freshnessParam) ? (freshnessParam as WebSearchOptions['freshness']) : undefined

  // Optional, diagnostic-only: Settings → Search's "test this backend" action
  // forces one specific backend (bypassing the failover chain) so a user can
  // check a freshly-pasted key actually works. Omitted by every normal
  // caller, which gets the full chain as usual.
  const backendParam = searchParams.get('backend') ?? ''
  const backend = VALID_BACKENDS.has(backendParam) ? (backendParam as WebSearchOptions['backend']) : undefined

  const result = await webSearch(query, { limit, freshness, backend, userId: user.id, timeoutMs: 12_000 })

  return NextResponse.json({
    ok: result.ok,
    backend: result.backend,
    count: result.results.length,
    results: result.results,
    reason: result.reason ?? null,
    detail: result.detail ?? null,
    // Only present when the chain tried more than one backend this call —
    // lets a caller explain precisely what happened instead of a flat reason.
    attempts: result.attempts ?? null,
  })
}
