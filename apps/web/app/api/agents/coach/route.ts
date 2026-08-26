// POST /api/agents/coach — a follow-up suggestion (+ drafted message, when one
// is due) for one application.
//
// Everything that used to live here — building a User/Application/Job/
// Company/Contact[] out of five separate reads and constructing packages/
// agents' CoachAgent (which reached a model through its own hand-rolled
// OpenAI/Anthropic fetch client, bypassing the spend cap entirely — this was
// THE live unmetered model path the langgraph port closes) — is gone.
// lib/graph/oneshot.ts#runUnitOnce -> lib/graph/unit.ts#runAgentUnit('coach')
// now does all of that DB work, the metered/demo-gated model call, and the
// journaling; this route's only job is auth, the 404 existence check (kept
// here rather than folded into the unit, same pattern app/api/outreach/
// draft/route.ts uses for its contact lookup), and shaping the response
// components/pipeline/application-detail-dialog.tsx already reads:
// {suggestion, draftMessage, suggestedContacts}, nothing else.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { runUnitOnce } from '@/lib/graph/oneshot'
import { BudgetCapError } from '@/lib/harness/spend'
import { CoachOutput } from '@/lib/harness/schemas'
import type { z } from 'zod'

type CoachResult = z.infer<typeof CoachOutput>

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { applicationId } = body
  if (!applicationId) {
    return NextResponse.json({ error: 'applicationId is required' }, { status: 400 })
  }

  // Existence check only — the unit re-reads the row itself (and everything
  // it needs off it) via the admin client, scoped by the SAME user_id.
  const { data: application, error: appError } = await supabase
    .from('applications')
    .select('id')
    .eq('id', applicationId)
    .eq('user_id', user.id)
    .single()
  if (appError || !application) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 })
  }

  const admin = createAdminClient()

  try {
    const result = await runUnitOnce('coach', {
      admin,
      userId: user.id,
      goal: `Coach application ${applicationId}`,
      input: { applicationId },
    })
    const output = result.output as CoachResult
    return NextResponse.json({
      suggestion: output.suggestion,
      draftMessage: output.draftMessage,
      suggestedContacts: output.suggestedContacts,
    })
  } catch (error) {
    if (error instanceof BudgetCapError) {
      return NextResponse.json(
        { error: error.message, reason: 'spend_cap', budgetExhausted: true },
        { status: 429 }
      )
    }
    console.error('Coach error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate coaching' },
      { status: 500 }
    )
  }
}
