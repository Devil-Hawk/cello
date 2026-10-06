// GET/PUT for profiles.preferences.constraints: the facts the person stated about
// roles they cannot or will not take (countries, on-site cities, sponsorship, a pay
// floor, companies, levels, words in a title). Cello hides a role only when its
// posting clearly breaks one of these, and says which.
//
// PUT is read-modify-write: preferences also holds api_keys, digest, model and
// targeting. A naive `.update({ preferences: { constraints } })` would wipe the
// saved API keys and every other preference, so the current row is read first and
// spread before writing.
//
// Saving also marks the person's roles for another look, so the next pass applies
// the new facts and the roles they now break show the reason.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { resolveConstraints } from '@/lib/scoring/constraints'

export const dynamic = 'force-dynamic'

const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'exec'] as const

const words = (max: number, len = 80) => z.array(z.string().trim().min(1).max(len)).max(max)
const countries = z.array(z.string().trim().length(2, 'Countries are two-letter codes like US')).max(60)

const Body = z.object({
  blockedCountries: countries,
  onlyCountries: countries,
  onsiteCities: words(30),
  needsSponsorship: z.boolean(),
  salaryFloorUsd: z.number().int().min(0).max(5_000_000).nullable(),
  remoteOnly: z.boolean(),
  excludedCompanies: words(100),
  refusedSeniority: z.array(z.enum(SENIORITY)).max(SENIORITY.length),
  excludedTitleWords: words(50, 40),
})

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await supabase.from('profiles').select('preferences').eq('id', user.id).maybeSingle()
  if (error) return NextResponse.json({ error: 'Failed to load dealbreakers' }, { status: 500 })
  return NextResponse.json({ constraints: resolveConstraints(data?.preferences ?? null) })
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return NextResponse.json({ error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body' }, { status: 400 })
  }
  const { data: profile, error: readError } = await supabase.from('profiles').select('preferences').eq('id', user.id).maybeSingle()
  if (readError) return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  const preferences = (profile?.preferences && typeof profile.preferences === 'object' ? profile.preferences : {}) as Record<string, unknown>
  // Only what the person typed here is stored under constraints (the older targeting lists are folded in when reading).
  const tidy = (xs: string[], f: (s: string) => string) => [...new Set(xs.map((x) => f(x.trim())).filter(Boolean))]
  const own = {
    blockedCountries: tidy(parsed.data.blockedCountries, (c) => c.toUpperCase()),
    onlyCountries: tidy(parsed.data.onlyCountries, (c) => c.toUpperCase()),
    onsiteCities: tidy(parsed.data.onsiteCities, (c) => c.toLowerCase()),
    needsSponsorship: parsed.data.needsSponsorship,
    salaryFloorUsd: parsed.data.salaryFloorUsd && parsed.data.salaryFloorUsd > 0 ? parsed.data.salaryFloorUsd : null,
    remoteOnly: parsed.data.remoteOnly,
    excludedCompanies: tidy(parsed.data.excludedCompanies, (c) => c.toLowerCase()),
    refusedSeniority: [...new Set(parsed.data.refusedSeniority)],
    excludedTitleWords: tidy(parsed.data.excludedTitleWords, (c) => c.toLowerCase()),
  }
  const { error: writeError } = await supabase.from('profiles').update({ preferences: { ...preferences, constraints: own } }).eq('id', user.id)
  if (writeError) {
    console.error('[settings/constraints] write failed:', writeError.message)
    return NextResponse.json({ error: 'Failed to save dealbreakers' }, { status: 500 })
  }

  // Roles assessed under the old facts get another look.
  try {
    // The person's own rows: the check date is theirs, so nobody else's roles are touched.
    const admin = createAdminClient()
    const { error } = await admin.from('person_roles').update({ assessed_at: null }).eq('user_id', user.id)
    if (error) throw error
  } catch (err) {
    console.error('[settings/constraints] could not mark roles for another look', err)
  }
  return NextResponse.json({ constraints: resolveConstraints({ ...preferences, constraints: own }) })
}
