// GET /api/chat/estimate?rung=&model=: what the picker shows next to Send. Free, an amount, or that the cost is not
// known before sending. Code and the price table, no model.
// ponytail: one typical answer (6,000 tokens in, 1,500 out); "at most" from the turn's caps comes with the real loop.

import { NextRequest, NextResponse } from 'next/server'
import { estimateChoice, parseChoice } from '@/lib/models/choice'
import { badRequest, chatSession, isResponse } from '../door'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await chatSession()
  if (isResponse(session)) return session
  const q = request.nextUrl.searchParams
  const choice = parseChoice({ rung: q.get('rung'), model: q.get('model'), effort: q.get('effort') ?? 'medium' })
  if (!choice) return badRequest('That is not a model choice.')
  return NextResponse.json(estimateChoice(choice, { prompt: 6000, completion: 1500 }))
}
