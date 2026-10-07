// inbox.sync: the hourly mail read. It runs the Gmail cron handler in this process, so the work is
// the same code the workflow used to trigger over HTTP.
//
// ponytail: calls the route handler directly. Switch to an exported function once the Gmail
// package owns the sync (K19), and keep POST until then.

import { POST } from '@/app/api/gmail/cron/route'
import type { NextRequest } from 'next/server'
import type { RoutineContext, RoutineOutcome } from '../routines'

export async function inboxSync(_ctx: RoutineContext): Promise<RoutineOutcome> {
  const secret = process.env.CRON_SECRET
  if (!secret) return { ok: false, failure: 'cron_secret_not_set' }
  const response = await POST(new Request('http://localhost/api/gmail/cron', { method: 'POST', headers: { authorization: `Bearer ${secret}` } }) as unknown as NextRequest)
  if (!response.ok) return { ok: false, failure: `gmail_cron_${response.status}` }
  const body = (await response.json().catch(() => ({}))) as { eligibleUsers?: number; processed?: number; results?: { error?: string }[] }
  const failed = (body.results ?? []).filter((r) => r.error).length
  return { ok: true, found: { connected: body.eligibleUsers ?? 0, read: (body.processed ?? 0) - failed, failed } }
}
