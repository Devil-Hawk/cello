// GET /api/learning/sp3: spike SP3, for the person who runs this deployment.
// Embeds one string on the server embedder and says how long it took and whether
// this call had to load the model (a cold start). Read the function size from the
// Vercel build output. Removed once the result is recorded in the K15 pull request.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isOpsOwner } from '@/lib/quality/ops-owner'
import { embed384 } from '@/lib/memory/embedder'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

let warm = false

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isOpsOwner(user.id)) return new NextResponse(null, { status: 404 })

  const cold = !warm
  const started = Date.now()
  const vectors = await embed384(['Forward deployed engineer at an AI company'])
  const ms = Date.now() - started
  if (vectors) warm = true
  return NextResponse.json({ ok: Boolean(vectors), dims: vectors?.[0]?.length ?? 0, ms, cold })
}
