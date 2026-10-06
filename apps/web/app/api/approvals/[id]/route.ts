// POST /api/approvals/[id] { decision: 'approve' | 'skip', edits?, acknowledge_version? }
//
// The person's click on a queued approval. Approve runs the one send (or submit) path, once, and
// stores its outcome; calling it again returns that outcome. `edits` are the person's own changes
// to the words, saved as a new version before the send, so what goes out is what they saw.
// `acknowledge_version` says they have looked at a version newer than the one queued.
// The answer is { copy, approval, error?, fix? }: `copy` is the line to show.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { decideApproval } from '@/lib/agents/approvals'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const Body = z.object({
  decision: z.enum(['approve', 'skip']),
  edits: z.object({ subject: z.string().max(300).optional(), body: z.string().max(20_000).optional(), text: z.string().max(40_000).optional() }).optional(),
  acknowledge_version: z.number().int().positive().optional(),
})

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body', fix: 'Send decision "approve" or "skip".' }, { status: 400 })

  const {
    data: { session },
  } = await supabase.auth.getSession()
  const result = await decideApproval({
    supabase,
    admin: createAdminClient(),
    user,
    session,
    id: params.id,
    decision: parsed.data.decision,
    by: 'user',
    edits: parsed.data.edits,
    acknowledgeVersion: parsed.data.acknowledge_version,
  })
  const { status, ...body } = result
  return NextResponse.json(body, { status })
}
