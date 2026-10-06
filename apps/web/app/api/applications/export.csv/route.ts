// GET /api/applications/export.csv: the person's applications as a CSV they can import again.

import { NextResponse } from 'next/server'
import { csvCell } from '@/lib/pipeline/add'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

type Row = { stage: string; applied_at: string | null; state: string | null; jobs: { title: string; url: string; companies: { name: string } | null } | null }

export async function GET() {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const { data, error } = await c.admin
    .from('applications')
    .select('stage, applied_at, state, jobs(title, url, companies(name))')
    .eq('user_id', c.userId)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) return NextResponse.json({ error: 'Could not export. Try again.' }, { status: 500 })
  const lines = ['company,title,url,stage,applied date,status']
  for (const r of (data ?? []) as unknown as Row[]) {
    lines.push([r.jobs?.companies?.name, r.jobs?.title, r.jobs?.url, r.stage, r.applied_at?.slice(0, 10), r.state].map((v) => csvCell(v)).join(','))
  }
  return new NextResponse(lines.join('\n') + '\n', {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="applications.csv"' },
  })
}
