// GET  /api/roles/:id/fit   what Cello concluded about this role: the stated facts it breaks (if any),
//                           how likely the person is to want it, and their chance with cited evidence.
// POST /api/roles/:id/fit   assesses this one role now (replaces the old on-demand match call).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm } from '@/lib/harness/llm'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import type { LlmRunner } from '@/lib/harness/types'
import { assessJobs, getRoleFit } from '@/lib/scoring'
import { scoringErrorResponse } from '@/lib/scoring/http'
import { setTraceMeta, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = { params: { id: string } }

export async function GET(_request: NextRequest, { params }: Ctx) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })
  const fit = await getRoleFit(supabase, user.id, params.id)
  if (!fit) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  return NextResponse.json(fit)
}

export async function POST(_request: NextRequest, { params }: Ctx) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })

  const admin = createAdminClient()
  return withTrace(admin, user.id, { name: 'assess-role' }, async () => {
    setTraceMeta({ job_id: params.id })
    const apiKeys = await loadApiKeys(admin, user.id)
    if (!canRunLlm(apiKeys)) {
      return NextResponse.json({ error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' }, { status: 400 })
    }
    try {
      const llm: LlmRunner = (opts) => callLlm(apiKeys, { ...opts, name: opts.name ?? 'assess-role' })
      const out = await assessJobs({ admin, userId: user.id, apiKeys, llm, jobIds: [params.id], limit: 1 })
      if (out.skippedReason === 'no-resume') return NextResponse.json({ error: 'No resume uploaded. Add one in Settings first.', skippedReason: 'no-resume' }, { status: 400 })
      if (out.skippedReason === 'no-llm-key') return NextResponse.json({ error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' }, { status: 400 })
      const fit = out.fits.get(params.id) ?? (await getRoleFit(admin, user.id, params.id))
      if (!fit) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
      return NextResponse.json(fit)
    } catch (err) {
      return scoringErrorResponse(err, apiKeys)
    }
  })
}
