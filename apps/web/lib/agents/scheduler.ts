// What lets work run in slices and on a schedule on a serverless host.
//
// A Vercel function lives for at most 300 seconds. So a long task runs in slices: each
// request stops starting new work after about 240 seconds, saves a checkpoint, and calls
// the continue endpoint, which picks the same conversation up in a fresh request. This file
// holds the pieces that make that safe:
//
//   - threads: one conversation or one occurrence of a scheduled task is one thread
//   - a lease on the thread, claimed with ONE conditional UPDATE, so two requests never
//     resume the same thread. (No advisory locks: the transaction pooler breaks them.)
//   - a signed continue request: HMAC over the body with a short expiry, so a leaked log
//     line cannot be replayed to start work. The endpoint that checks it is the clock's
//     (app/api/agent/continue); this file only signs and fires
//   - firing that request after the response, with waitUntil

import { createHmac, randomUUID } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { ThreadOwnershipError, DemoThreadExpiredError } from '@/lib/graph/invoke'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import type { AdminClient } from '@/lib/harness/types'

// --- threads ------------------------------------------------------------------------

export type AgentSurface = 'agent' | 'scheduled'

export class OldConversationError extends Error {
  constructor() {
    super('This conversation is from the earlier Copilot. Start a new one to continue.')
    this.name = 'OldConversationError'
  }
}

export interface ThreadRow {
  thread_id: string
  user_id: string
  surface: string
  conversation_id: string | null
  expires_at: string | null
}

/**
 * The thread for a conversation or occurrence, created when new. A thread belongs to one
 * person: a missing row and someone else's row fail the same way. A conversation from the
 * earlier Copilot (surface "copilot") stays readable but is not resumed here.
 */
export async function ensureThread(
  admin: AdminClient,
  userId: string,
  opts: { surface: AgentSurface; threadId?: string; conversationId?: string | null }
): Promise<ThreadRow> {
  if (opts.threadId) {
    const { data } = await admin.from('graph_threads').select('thread_id, user_id, surface, conversation_id, expires_at').eq('thread_id', opts.threadId).maybeSingle()
    const row = data as ThreadRow | null
    if (!row || row.user_id !== userId) throw new ThreadOwnershipError(opts.threadId)
    if (row.surface === 'copilot') throw new OldConversationError()
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new DemoThreadExpiredError(opts.threadId)
    return row
  }
  // A demo's thread expires with the demo.
  const { row: profile } = await readProfileForDemoGuards(admin, userId)
  const expiresAt = profile && !profile.demoColumnsAbsent && profile.is_demo ? (profile.demo_expires_at ?? null) : null
  const { data, error } = await admin
    .from('graph_threads')
    .insert({ user_id: userId, surface: opts.surface, conversation_id: opts.conversationId ?? null, expires_at: expiresAt })
    .select('thread_id, user_id, surface, conversation_id, expires_at')
    .single()
  if (error || !data) throw new Error(`Could not start the conversation: ${error?.message ?? 'no row'}`)
  return data as ThreadRow
}

// --- the lease ----------------------------------------------------------------------

/** How long one request may hold a thread without renewing. The heartbeat renews it every 30 seconds. */
export const LEASE_MS = 120_000

export interface Lease {
  threadId: string
  holder: string
}

/**
 * Claim the thread: one conditional UPDATE that succeeds only when nobody holds it or the
 * last holder's lease has run out. Returns null when someone else is running it.
 */
export async function claimLease(admin: AdminClient, threadId: string, ms: number = LEASE_MS, now: Date = new Date()): Promise<Lease | null> {
  const holder = randomUUID()
  const { data } = await admin
    .from('graph_threads')
    .update({ lease_until: new Date(now.getTime() + ms).toISOString(), lease_holder: holder, last_invoked_at: now.toISOString() })
    .eq('thread_id', threadId)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select('thread_id')
  return ((data as unknown[] | null) ?? []).length > 0 ? { threadId, holder } : null
}

/** Keep the lease while the request is alive. A lease someone else now holds is not touched. */
export async function renewLease(admin: AdminClient, lease: Lease, ms: number = LEASE_MS): Promise<boolean> {
  const { data } = await admin
    .from('graph_threads')
    .update({ lease_until: new Date(Date.now() + ms).toISOString() })
    .eq('thread_id', lease.threadId)
    .eq('lease_holder', lease.holder)
    .select('thread_id')
  return ((data as unknown[] | null) ?? []).length > 0
}

/** Give the thread back. Only the holder can. */
export async function releaseLease(admin: AdminClient, lease: Lease): Promise<void> {
  await admin.from('graph_threads').update({ lease_until: null, lease_holder: null }).eq('thread_id', lease.threadId).eq('lease_holder', lease.holder)
}

// --- the signed continue request ----------------------------------------------------

export type ContinueReason = 'slice' | 'stale' | 'due'

export interface ContinuePayload {
  reason: ContinueReason
  thread_id?: string
  scheduled_task_id?: string
  /** Run a scheduled task now even if it is not due (Run now). */
  force?: boolean
  /** Seconds since the epoch. */
  exp: number
}

/** The longest an `exp` may be ahead of now. The sweeper signs five minutes ahead. */
export const MAX_EXP_AHEAD_S = 300

function secret(): string {
  const s = process.env.AGENT_CONTINUE_SECRET
  if (!s || s.length < 16) throw new Error('Set AGENT_CONTINUE_SECRET (at least 16 characters) to sign continue requests. See docs/AGENTS.md.')
  return s
}

// ponytail: K4's lib/clock/sign.ts signs the same way; the rebase on main re-exports it from there and drops this copy.
export const signContinue = (rawBody: string, key: string = secret()): string => createHmac('sha256', key).update(rawBody, 'utf8').digest('hex')

export function continueBody(payload: Omit<ContinuePayload, 'exp'>, nowMs: number = Date.now()): string {
  return JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + MAX_EXP_AHEAD_S })
}

export function continueUrl(): string {
  if (process.env.AGENT_CONTINUE_URL) return process.env.AGENT_CONTINUE_URL
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  return `${origin.replace(/\/$/, '')}/api/agent/continue`
}

/** Off Vercel, waitUntil does nothing, so the request is awaited briefly instead. */
const LOCAL_WAIT_MS = 3000

/**
 * Ask the continue endpoint to carry on, after the response is sent. Never throws: if the
 * request cannot be made, the minute sweeper finds the stale task and does it.
 */
export async function fireContinue(payload: Omit<ContinuePayload, 'exp'>, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const body = continueBody(payload)
    const request = fetchImpl(continueUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cello-signature': signContinue(body) },
      body,
    }).catch((e) => console.error('[agents] continue request failed; the sweeper will pick it up', e instanceof Error ? e.message : e))
    if (process.env.VERCEL) waitUntil(request)
    else await Promise.race([request, new Promise((resolve) => setTimeout(resolve, LOCAL_WAIT_MS))])
  } catch (e) {
    console.error('[agents] could not sign a continue request', e instanceof Error ? e.message : e)
  }
}
