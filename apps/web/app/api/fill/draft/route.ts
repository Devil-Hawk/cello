// POST /api/fill/draft: "Draft this" on a long question, from the extension. A draft is the Writer's
// (K17) and is shown to the person in the tab, never filled by itself and never stored as their answer.
//
// Until the Writer is on this deployment the route answers plainly and does nothing: Cello never
// invents a long answer in a code path.

import { NextRequest, NextResponse } from 'next/server'
import { fillAuth, isFillAuth } from '@/lib/fill/auth'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const a = await fillAuth(request)
  if (!isFillAuth(a)) return a
  return NextResponse.json({ error: 'Drafting an answer is not available yet. Write this one yourself.' }, { status: 503 })
}
