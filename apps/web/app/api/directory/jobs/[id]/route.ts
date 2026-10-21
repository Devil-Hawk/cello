import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { finishRenderJob, readSigned, type RenderJob } from '@/lib/companies/render-jobs'
import { followForJob } from '@/lib/companies/find'
import { realDeps } from '@/lib/companies/verify-directory'

// POST /api/directory/jobs/[id]   (signed by the pull worker)
//
// The worker's answer for a job it claimed: {ok, html, final_url, rung} for a careers page, {ok, domains} for a search,
// or {ok: false, error: <class>}. The page is verified like any candidate's (lib/companies/render-jobs.ts); the job ends
// done or failed, and the person who asked follows the employer it proved. A second answer for a finished job is accepted and ignored, so a lost reply can be sent again.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const signed = readSigned(await request.text(), request.headers.get('x-cello-signature'))
  if (!signed.ok) return NextResponse.json({ error: signed.status === 503 ? 'not_configured' : signed.status === 400 ? 'bad_request' : 'unauthorized' }, { status: signed.status })
  if (signed.body.id !== params.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 }) // signed for another job
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const db = createAdminClient()
  const { data } = await db.from('render_jobs').select('id, kind, candidate_id, url, query, state, requested_by').eq('id', params.id).maybeSingle()
  const job = data as RenderJob | null
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (job.state === 'done' || job.state === 'failed') return NextResponse.json({ ok: true, already: true })
  if (job.state !== 'claimed') return NextResponse.json({ error: 'not_claimed' }, { status: 409 })

  let employerId: string | null
  try {
    employerId = (await finishRenderJob(db, job, signed.body, realDeps)).employerId
  } catch (error) {
    // The job stays claimed and is taken back after 20 minutes. The class only: the page's address is not logged.
    console.error('[render-jobs] settle failed', error instanceof Error ? error.name : 'error')
    return NextResponse.json({ error: 'settle_failed' }, { status: 500 })
  }
  // The job is done whatever follows: a proven employer is followed for the person who asked, and a failure here only costs that.
  await followForJob(db, job, employerId).catch((error) => console.error('[render-jobs] follow failed', error instanceof Error ? error.name : 'error'))
  return NextResponse.json({ ok: true })
}
