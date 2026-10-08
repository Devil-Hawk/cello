// GET /api/settings/pipeline: what Cello does on its own, as the person set it (paused or not, pick time, limits).
// PUT: change some of it. The write is autonomy.update (set_autonomy in SQL); this route only merges the change into
// what is stored and hands it in. A door and nothing else.

import { NextRequest, NextResponse } from 'next/server'
import { sessionDoor } from '@/lib/commands/doors'
import { runCommand } from '@/lib/commands/run'
import { refusalToResponse } from '@/lib/commands/http'
import { autonomyUpdate } from '@/lib/commands/defs/core'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { resolveDigestPreferences } from '@/lib/digest/types'
import { FILL_SCOPE } from '@/lib/fill/auth'
import { applyPatch, PatchSchema } from './patch'

export const dynamic = 'force-dynamic'

async function stored(ctx: Awaited<ReturnType<typeof sessionDoor>>) {
  const { data } = await ctx.admin().from('profiles').select('preferences').eq('id', ctx.userId).maybeSingle()
  return ((data as { preferences?: Record<string, unknown> | null } | null)?.preferences ?? {}) as Record<string, unknown>
}

const view = (preferences: Record<string, unknown>) => {
  const pipeline = (preferences.pipeline ?? {}) as Record<string, unknown>
  const weeklyPace = typeof pipeline.weeklyPace === 'number' ? pipeline.weeklyPace : null
  return { settings: readPipelineSettings(preferences), weeklyPace, digest: resolveDigestPreferences(preferences.digest).enabled }
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    return NextResponse.json(view(await stored(ctx)))
  } catch (e) {
    return refusalToResponse(e)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const ctx = await sessionDoor(request)
    const parsed = PatchSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That setting is not valid.' }, { status: 400 })
    const preferences = await stored(ctx)

    // Send for me binds to the person's one live extension token
    let tokenId: string | null = null
    if (parsed.data.send?.on) {
      const { data } = await ctx.admin().from('api_tokens').select('id').eq('user_id', ctx.userId).is('revoked_at', null).contains('scopes', [FILL_SCOPE]).order('created_at', { ascending: false }).limit(1)
      tokenId = (data as { id: string }[] | null)?.[0]?.id ?? null
    }
    let merged: Record<string, unknown>
    try {
      merged = applyPatch(preferences.pipeline, parsed.data, tokenId)
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'That setting is not valid.' }, { status: 400 })
    }
    await runCommand(autonomyUpdate, ctx, { pipeline: merged })
    return NextResponse.json(view({ ...preferences, pipeline: merged }))
  } catch (e) {
    return refusalToResponse(e)
  }
}
