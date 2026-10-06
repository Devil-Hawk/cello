import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { DISMISS_REASONS } from '@/lib/companies/types'
import { actOnSuggestion } from '@/lib/companies/suggestions-store'

// POST /api/companies/suggestions/[id] { action: 'add' | 'dismiss' | 'undo', reason?, dream? }
//
// add      follow the employer (companies.add: a verified employer as it is, any other checked through its own site) and record it
// dismiss  hide it, with an optional reason, so it is never suggested again
// undo     bring a dismissed suggestion back
// Both outcomes are stored with the tier, rank and evidence the row had, which
// is the feedback log for later ranking.

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), dream: z.boolean().optional() }),
  z.object({ action: z.literal('dismiss'), reason: z.enum(DISMISS_REASONS).optional() }),
  z.object({ action: z.literal('undo') }),
])

const IdSchema = z.string().uuid()

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = IdSchema.safeParse(params.id)
  if (!id.success) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const body = Body.safeParse(json)
  if (!body.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 })

  try {
    const result = await actOnSuggestion({ db: supabase, admin: createAdminClient(), userId: user.id, id: id.data, act: body.data })
    if (result.kind === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (result.kind === 'conflict') return NextResponse.json({ error: result.error }, { status: 409 })
    // The employer could not be verified and followed: the suggestion stays open, and the page shows why and what Cello found instead.
    if (result.kind === 'not_added') return NextResponse.json({ status: 'open', notAdded: { reason: result.reason, line: result.line, offers: result.offers } })
    return NextResponse.json({ status: result.status, ...(result.added ? { company: result.added } : {}) })
  } catch (error) {
    console.error('Suggestion action error:', error)
    return NextResponse.json({ error: 'Could not update the suggestion.' }, { status: 500 })
  }
}
