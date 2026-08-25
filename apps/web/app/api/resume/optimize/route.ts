// POST /api/resume/optimize  { jobId }
//
// The jobright-style resume ATS optimizer surface for a single job:
// score the user's resume against the role, list missing keywords + format
// issues, produce an honesty-constrained rewrite, and rescore it.
//
// Uses the harness resume_optimizer module with the signed-in user's decrypted
// OpenRouter key (loaded via the service-role client). The rewrite NEVER
// fabricates content — that rule lives in the optimizer module's prompts.
//
// optimizeResume() makes THREE serial LLM calls (score original, rewrite,
// rescore rewrite) — on Vercel's default 60s limit that reliably 504'd with an
// HTML body the client's res.json() then threw on, producing one generic
// "optimization failed" line no matter which pass actually broke. Fixed two
// ways: (1) maxDuration raised to 300s (Vercel now allows it) so three serial
// calls have room to complete; (2) a call-counting LlmRunner wraps the SAME
// unmodified optimizeResume() so a failure's JSON body names WHICH of the
// three passes was in flight, without needing resume_optimizer.ts to know
// anything about "passes" itself.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { optimizeResume } from '@/lib/harness/agents/resume_optimizer'
import { callLlm, MissingKeyError } from '@/lib/harness/llm'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import type { DecryptedApiKeys, LlmRunner } from '@/lib/harness/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * optimizeResume() always issues its three LLM calls in this fixed order —
 * see lib/harness/agents/resume_optimizer.ts's optimizeResume: scoreResume
 * (original), rewriteResume, scoreResume (rescore). Never reordered/retried,
 * so a simple call counter reliably names the in-flight pass on failure.
 */
const PASS_LABELS = ['score original resume', 'generate ATS rewrite', 'rescore rewrite'] as const

/**
 * Wrap callLlm in a counter so a thrown error — whether from the HTTP call
 * itself or from parsing its response back in resume_optimizer.ts — can be
 * attributed to the pass that was in flight when it started. `passIndex()`
 * reads the count of calls STARTED so far (1-based); read it from the catch
 * block, not before.
 */
function trackedLlm(apiKeys: DecryptedApiKeys): { llm: LlmRunner; passIndex: () => number } {
  let started = 0
  const llm: LlmRunner = (opts) => {
    started += 1
    return callLlm(apiKeys, opts)
  }
  return { llm, passIndex: () => started }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let jobId: string
  try {
    const body = await request.json()
    jobId = typeof body?.jobId === 'string' ? body.jobId : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })

  const admin = createAdminClient()

  // Resume text (source of truth — never fabricated against).
  const { data: profile } = await admin
    .from('profiles')
    .select('resume_text')
    .eq('id', user.id)
    .single()
  const resumeText = (profile?.resume_text as string | null) ?? ''
  if (!resumeText.trim()) {
    return NextResponse.json(
      { error: 'No resume on file. Upload your resume in Settings first.', needsResume: true },
      { status: 400 }
    )
  }

  // Job + company (RLS-scoped read via the signed-in client).
  const { data: job } = await supabase
    .from('jobs')
    .select('id, title, description, companies(name)')
    .eq('id', jobId)
    .single()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const companyRel = (job as { companies?: { name?: string } | { name?: string }[] | null }).companies
  const companyName = Array.isArray(companyRel) ? companyRel[0]?.name : companyRel?.name

  // PROVIDER GATE ALIGNMENT: the harness only ever calls OpenRouter — gate on
  // canRunLlm(apiKeys), and explain the gap when the account has an
  // openai/anthropic key but no OpenRouter key, not a bare "missing key".
  const apiKeys = await loadApiKeys(admin, user.id)
  if (!canRunLlm(apiKeys)) {
    return NextResponse.json(
      { error: missingOpenRouterMessage(apiKeys), needsKey: true },
      { status: 400 }
    )
  }

  const { llm, passIndex } = trackedLlm(apiKeys)
  try {
    const result = await optimizeResume({
      resumeText,
      job: { title: job.title, company: companyName ?? null, description: job.description },
      llm,
    })
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    const idx = passIndex()
    const pass = idx >= 1 && idx <= PASS_LABELS.length ? PASS_LABELS[idx - 1] : null
    const baseMessage = e instanceof Error ? e.message : 'Resume optimization failed'
    console.error(
      `[resume/optimize] job=${jobId} user=${user.id} pass="${pass ?? 'unknown'}" (call #${idx}) failed:`,
      e
    )
    if (e instanceof MissingKeyError) {
      return NextResponse.json(
        { error: missingOpenRouterMessage(apiKeys), needsKey: true, pass },
        { status: 400 }
      )
    }
    return NextResponse.json(
      {
        error: pass ? `Resume optimization failed during "${pass}": ${baseMessage}` : baseMessage,
        pass,
        passIndex: idx || null,
      },
      { status: 500 }
    )
  }
}
