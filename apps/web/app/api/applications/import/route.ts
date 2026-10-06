// POST /api/applications/import: a CSV with the columns company, title, url, stage, applied date.
// Each row becomes an application with no state (Cello is not working on it), at most 500 rows.
// Send the CSV as the body, or as { csv } in JSON.

import { NextRequest, NextResponse } from 'next/server'
import { addByHand, readImport } from '@/lib/pipeline/add'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 1_000_000

export async function POST(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const raw = await request.text()
  if (raw.length > MAX_BYTES) return NextResponse.json({ error: 'That file is too large. Keep it under 1 MB.' }, { status: 413 })
  let csv = raw
  if ((request.headers.get('content-type') ?? '').includes('json')) {
    try {
      const j = JSON.parse(raw) as { csv?: unknown }
      csv = typeof j.csv === 'string' ? j.csv : ''
    } catch {
      return NextResponse.json({ error: 'Send JSON.' }, { status: 400 })
    }
  }
  const { rows, sentence } = readImport(csv)
  if (sentence) return NextResponse.json({ error: sentence }, { status: 400 })

  let added = 0
  let existed = 0
  const skipped: { row: number; error: string }[] = []
  for (const [i, row] of rows.entries()) {
    const r = await addByHand(c.admin, c.userId, row, 'import')
    if (!r.ok) skipped.push({ row: i + 2, error: r.sentence })
    else if (r.existed) existed++
    else added++
  }
  return NextResponse.json({ added, existed, skipped })
}
