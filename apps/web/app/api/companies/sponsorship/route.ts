// GET/POST /api/companies/sponsorship
//
// Zero-LLM-cost H-1B sponsorship SIGNAL lookup for one or many company names.
// This is the direct entry point lib/dossier/visa.ts's curated-list check was
// missing: resolveVisaSignal (the careers-page-parse + curated-list combo) was
// only ever reachable from inside company_researcher's dossier generation, so
// a company only got a signal once a full (LLM-backed) dossier existed for it.
// Of 449 tracked companies, only 3 had dossiers, and all 3 read 'none' — the
// sponsorship filter had no data behind it for 446 companies. This route
// exposes the free half of that signal (the curated DoL-derived list) directly,
// with no LLM call and no dossier required, for a single name or a batch.
//
// GET  ?name=Snowflake+Inc.                 -> one lookup
// GET  ?names=Google,Snowflake+Inc.,Acme     -> bulk lookup (comma-separated)
// POST { "names": string[] }                 -> bulk lookup (JSON body)
//
// Every response carries the same honest caveat this signal always requires
// (SPONSORSHIP_SIGNAL_NOTE): a likely-to-sponsor match is a track record, not
// a guarantee for any specific role, team, or year.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  sponsorshipSignalForCompanies,
  SPONSORSHIP_SIGNAL_NOTE,
  type SponsorshipLookup,
} from '@/lib/dossier/visa'

export const dynamic = 'force-dynamic'

/** Hard cap on one request's batch size — this is a cheap in-memory lookup
 *  (no LLM, no network, no DB), but an unbounded list is still an unbounded
 *  response body for no product reason. */
const MAX_NAMES = 200

function parseNamesParam(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_NAMES)
}

interface SponsorshipResponse {
  ok: true
  note: string
  count: number
  results: SponsorshipLookup[]
}

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const single = url.searchParams.get('name')
  const bulk = parseNamesParam(url.searchParams.get('names'))
  const names = single ? [single.trim(), ...bulk] : bulk

  if (names.length === 0) {
    return NextResponse.json(
      { error: 'Pass ?name=<company> or ?names=<comma,separated,list>' },
      { status: 400 }
    )
  }

  const results = sponsorshipSignalForCompanies(names)
  return NextResponse.json({
    ok: true,
    note: SPONSORSHIP_SIGNAL_NOTE,
    count: results.length,
    results,
  } satisfies SponsorshipResponse)
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const raw = (body as { names?: unknown } | null)?.names
  const names = Array.isArray(raw)
    ? raw.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).slice(0, MAX_NAMES)
    : []

  if (names.length === 0) {
    return NextResponse.json({ error: 'Body must be { "names": string[] } with at least one name' }, { status: 400 })
  }

  const results = sponsorshipSignalForCompanies(names)
  return NextResponse.json({
    ok: true,
    note: SPONSORSHIP_SIGNAL_NOTE,
    count: results.length,
    results,
  } satisfies SponsorshipResponse)
}
