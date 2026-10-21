import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { finishRenderJob, readSigned, type RenderJob } from '@/lib/companies/render-jobs'
import { realDeps } from '@/lib/companies/verify-directory'

// POST /api/directory/jobs/[id]   (signed by the pull worker)
//
// The worker's answer for a job it claimed: {ok, html, final_url, rung} for a careers page, {ok, domains} for a search,
// or {ok: false, error: <class>}. The page is verified like any candidate's (lib/companies/render-jobs.ts); the job ends
// done or failed. A second answer for a finished job is accepted and ignored, so a lost reply can be sent again.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const signed = readSigned(await request.text(), request.headers.get('x-cello-signature'))
  if (!signed.ok) return NextResponse.json({ error: signed.status === 503 ? 'not_configured' : signed.status === 400 ? 'bad_request' : 'unauthorized' }, { status: signed.status })
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const db = createAdminClient()
  const { data } = await db.from('render_jobs').select('id, kind, candidate_id, url, query, state').eq('id', params.id).maybeSingle()
  const job = data as RenderJob | null
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (job.state === 'done' || job.state === 'failed') return NextResponse.json({ ok: true, already: true })
  if (job.state !== 'claimed') return NextResponse.json({ error: 'not_claimed' }, { status: 409 })

  try {
    await finishRenderJob(db, job, signed.body, realDeps)
  } catch (error) {
    // The job stays claimed and is taken back after 20 minutes. The class only: the page's address is not logged.
    console.error('[render-jobs] settle failed', error instanceof Error ? error.name : 'error')
    return NextResponse.json({ error: 'settle_failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
