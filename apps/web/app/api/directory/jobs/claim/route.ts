import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { readSigned, type RenderJob } from '@/lib/companies/render-jobs'

// POST /api/directory/jobs/claim   (signed by the pull worker, body {"exp": <seconds>})
//
// Hands the worker the oldest queued browser read: 200 with {id, kind, url, query}, or 204 when there is none. A claim
// the worker leaves for 20 minutes is taken back by claim_render_job(). The signature is checked over the raw bytes
// before the body is read (lib/companies/render-jobs.ts readSigned).

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const signed = readSigned(await request.text(), request.headers.get('x-cello-signature'))
  if (!signed.ok) return NextResponse.json({ error: signed.status === 503 ? 'not_configured' : signed.status === 400 ? 'bad_request' : 'unauthorized' }, { status: signed.status })

  const { data, error } = await createAdminClient().rpc('claim_render_job')
  if (error) {
    console.error('[render-jobs] claim failed')
    return NextResponse.json({ error: 'claim_failed' }, { status: 500 })
  }
  // A function that returns a set answers a list; a lone row or an all-null row is the same as none.
  const job = (Array.isArray(data) ? data[0] : data) as RenderJob | null
  if (!job?.id) return new NextResponse(null, { status: 204 })
  return NextResponse.json({ id: job.id, kind: job.kind, url: job.url, query: job.query })
}
