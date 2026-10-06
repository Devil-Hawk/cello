// POST /api/answers/save-from-attempt: { attemptId, answers: [{ question, answer, kind?, options? }] }.
// The ticked answers of one sent application, saved for next time. Sensitive questions and consents
// are skipped, whatever the request says.

import { NextRequest, NextResponse } from 'next/server'
import { saveFromAttempt } from '@/lib/answers'
import { UUID, writerCtx } from '@/lib/answers/session'
import { isCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const c = await writerCtx()
  if (!isCtx(c)) return c
  const b = (await request.json().catch(() => null)) as { attemptId?: unknown; answers?: unknown } | null
  if (typeof b?.attemptId !== 'string' || !UUID.test(b.attemptId) || !Array.isArray(b.answers)) {
    return NextResponse.json({ error: 'Say which application and which answers.' }, { status: 400 })
  }
  const { data: attempt } = await c.admin.from('application_attempts').select('id, application_id').eq('id', b.attemptId).eq('user_id', c.userId).maybeSingle()
  if (!attempt) return NextResponse.json({ error: 'That application is gone.' }, { status: 404 })
  const applicationId = (attempt as { application_id: string | null }).application_id
  let companyId: string | null = null
  let companyName: string | null = null
  if (applicationId) {
    const { data } = await c.admin.from('applications').select('jobs(companies(id, name))').eq('id', applicationId).eq('user_id', c.userId).maybeSingle()
    const co = (data as { jobs?: { companies?: { id: string; name: string } | null } | null } | null)?.jobs?.companies
    companyId = co?.id ?? null
    companyName = co?.name ?? null
  }
  const items = (b.answers as Record<string, unknown>[])
    .filter((a) => a && typeof a.question === 'string')
    .map((a) => ({
      question: a.question as string,
      answer: a.answer,
      kind: typeof a.kind === 'string' ? (a.kind as never) : undefined,
      options: Array.isArray(a.options) ? (a.options as unknown[]).filter((o): o is string => typeof o === 'string') : undefined,
    }))
  return NextResponse.json({ ok: true, ...(await saveFromAttempt(c.admin, c.userId, { applicationId, attemptId: b.attemptId, companyId, companyName }, items)) })
}
