// POST /api/chat/[id]/proposals/[pid]: the person's Confirm or Not now on a card. Confirm re-reads the stored payload and
// runs exactly that, as the person; the model is not involved. A proposal that is not theirs, or not in this chat, is
// not found.

import { NextRequest, NextResponse } from 'next/server'
import { isDemoProfile } from '@/lib/access/guardrails'
import { mcpTargets } from '@/lib/chat/mcp-confirm'
import { confirmProposal, dismissProposal } from '@/lib/chat/proposals'
import { badRequest, chatSession, isResponse, readJson } from '../../../door'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: { id: string; pid: string } }) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const { db, userId } = session
  const body = await readJson(request)
  const decision = body?.decision
  if (decision !== 'confirm' && decision !== 'dismiss') return badRequest('Send confirm or dismiss.')

  const { data: row } = await db.from('proposals').select('id').eq('id', params.pid).eq('user_id', userId).eq('chat_id', params.id).maybeSingle()
  if (!row) return NextResponse.json({ error: 'not_found', message: 'That was not found.' }, { status: 404 })

  let done
  if (decision === 'dismiss') done = await dismissProposal(db, userId, params.pid)
  else {
    const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
    done = await confirmProposal(db, userId, params.pid, mcpTargets({ chatId: params.id, isDemo: isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null) }))
  }
  return done.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'refused', message: done.error, fix: done.fix }, { status: 409 })
}
