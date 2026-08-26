// GET /.well-known/agent-card.json — public, unauthenticated A2A agent
// card discovery (A2A spec: a client fetches this before ever sending a
// message). A route handler, not a static file, so the URL is exactly
// spec-shaped (a literal `.well-known` path segment) and `url`/
// `preferredTransport` always point at THIS deployment's own /api/a2a,
// derived from the request rather than a static env var.
//
// NO SECRETS: this is the classic v0.3 wire-shaped card
// (lib/a2a/card.ts#buildWireAgentCard) — it declares the bearer
// securityScheme a caller must use, never a credential itself. Public GET,
// no auth check, matching the A2A spec's own discovery contract.

import { NextRequest, NextResponse } from 'next/server'
import { buildWireAgentCard } from '@/lib/a2a/card'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const a2aUrl = new URL('/api/a2a', request.nextUrl.origin).toString()
  return NextResponse.json(buildWireAgentCard(a2aUrl), { headers: { 'Cache-Control': 'public, max-age=300' } })
}
