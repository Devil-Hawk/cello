// GET /api/access-codes/:id/events — the audit trail for one code, newest
// first, paginated.
//
// This route IS the feature: "we should be able to see what someone did with a
// particular access code". It returns sentences, not rows — the humanising
// lives in ../../contract.ts so every view of a trail speaks the same language.
//
// Reads run under the owner's own session. access_code_events has a SELECT
// policy scoped through the parent code's owner and NO insert policy at all, so
// a demo session can neither read someone else's trail nor write its own.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import {
  ACCESS_CODE_EVENT_COLUMNS,
  describeAccessCodeEvent,
  type AccessCodeEventRow,
} from '../../contract'
import { NO_STORE, isUuid } from '../../http'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  if (!isUuid(params.id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  const db = supabase as unknown as SupabaseClient

  // Confirm the code is this owner's BEFORE reading the trail. RLS would return
  // an empty list anyway, but an empty list reads as "they did nothing", and
  // that is a different — and misleading — answer from "that is not your code".
  const { data: code, error: codeError } = await db
    .from('access_codes')
    .select('id')
    .eq('id', params.id)
    .eq('owner_user_id', user.id)
    .maybeSingle()

  if (codeError) {
    console.error('[access-codes] events ownership check failed', codeError)
    return NextResponse.json(
      { error: "Couldn't load the activity for this code." },
      { status: 500, headers: NO_STORE }
    )
  }
  if (!code) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  const { searchParams } = new URL(request.url)
  const limit = clampInt(searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  // Offset paging, ordered by (occurred_at desc, id desc) so the ordering is
  // total and a page boundary can never split or duplicate two events written
  // in the same transaction. Offset rather than a keyset cursor because this is
  // a bounded, after-the-fact read — a code lives 72 hours — and a cursor built
  // from a timestamp is the kind of thing that silently drops rows sharing a
  // microsecond. The UI has an explicit refresh for the shifting-window case.
  //
  // limit + 1 tells us whether another page exists without a second count query.
  const { data, error } = await db
    .from('access_code_events')
    .select(ACCESS_CODE_EVENT_COLUMNS)
    .eq('code_id', params.id)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit)

  if (error) {
    console.error('[access-codes] events query failed', error)
    return NextResponse.json(
      { error: "Couldn't load the activity for this code." },
      { status: 500, headers: NO_STORE }
    )
  }

  const rows = (data ?? []) as AccessCodeEventRow[]
  const hasMore = rows.length > limit
  const events = rows.slice(0, limit).map(describeAccessCodeEvent)

  return NextResponse.json(
    { events, hasMore, nextOffset: hasMore ? offset + limit : null },
    { headers: NO_STORE }
  )
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
