// GET /api/answers: the person's saved answers, open questions first. A question that names an
// employer carries that employer; the two work facts are not listed as questions.

import { NextResponse } from 'next/server'
import { readerCtx } from '@/lib/answers/session'
import { isCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  const c = await readerCtx()
  if (!isCtx(c)) return c
  const { data, error } = await c.admin
    .from('answer_bank')
    .select('id, question, category, sensitive, kind, options, answer, declined, company_id, source, origin, confirmed_at, use_count, last_used_at, updated_at')
    .eq('user_id', c.userId)
    .not('question_key', 'like', 'fact:%')
    .order('updated_at', { ascending: false })
    .limit(500)
  if (error) return NextResponse.json({ error: 'Could not load your answers. Try again.' }, { status: 500 })
  const rows = data ?? []
  const open = rows.filter((r) => r.answer === null && !r.declined)
  return NextResponse.json({ open, saved: rows.filter((r) => !open.includes(r)) })
}
