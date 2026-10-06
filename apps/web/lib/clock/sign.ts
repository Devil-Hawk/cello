// The one signed door for background work. pg_cron runs agent_sweep() every minute and posts a
// body to /api/agent/continue; the body is signed with HMAC-SHA256 (hex, header X-Cello-Signature)
// over its exact bytes, and carries `exp`, at most five minutes ahead. This is the one verifier.
// The engine's scheduler (lib/agents/scheduler.ts) imports signContinue and verifyContinue from here.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type ContinueReason = 'routine' | 'slice' | 'stale' | 'due'

export interface ContinuePayload {
  reason: ContinueReason
  /** reason routine: the routines row to run. */
  routine_id?: string
  /** reason routine: where the last slice stopped (the routine's own bookkeeping). */
  slice?: Record<string, unknown>
  /** The engine's reasons. */
  thread_id?: string
  scheduled_task_id?: string
  force?: boolean
  /** Seconds since the epoch. */
  exp: number
}

/** The longest an `exp` may be ahead of now. The sweeper signs five minutes ahead. */
export const MAX_EXP_AHEAD_S = 300

const REASONS: readonly string[] = ['routine', 'slice', 'stale', 'due']

function secret(): string {
  const s = process.env.AGENT_CONTINUE_SECRET
  if (!s || s.length < 16) throw new Error('Set AGENT_CONTINUE_SECRET (at least 16 characters) to sign continue requests.')
  return s
}

export const signContinue = (rawBody: string, key: string = secret()): string => createHmac('sha256', key).update(rawBody, 'utf8').digest('hex')

export function continueBody(payload: Omit<ContinuePayload, 'exp'>, nowMs: number = Date.now()): string {
  return JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + MAX_EXP_AHEAD_S })
}

export type VerifyResult =
  | { ok: true; payload: ContinuePayload }
  | { ok: false; reason: 'no_signature' | 'bad_signature' | 'bad_body' | 'expired' | 'too_far' }

/** Check a continue request: the signature over the exact raw body, then the expiry. */
export function verifyContinue(rawBody: string, signature: string | null | undefined, nowMs: number = Date.now(), key: string = secret()): VerifyResult {
  if (!signature) return { ok: false, reason: 'no_signature' }
  const given = Buffer.from(signature, 'hex')
  const matches = (text: string): boolean => {
    const expected = Buffer.from(signContinue(text, key), 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  let payload: ContinuePayload
  try {
    payload = JSON.parse(rawBody) as ContinuePayload
  } catch {
    // Not JSON: it can only be a bad signature or a bad body, and the caller learns neither.
    return { ok: false, reason: matches(rawBody) ? 'bad_body' : 'bad_signature' }
  }
  // The sweeper signs the jsonb text of the body. If the transport sent other bytes (compact JSON),
  // the same body in jsonb's own form still proves the signer held the secret.
  if (!matches(rawBody) && !matches(pgJsonbText(payload))) return { ok: false, reason: 'bad_signature' }
  if (!payload || typeof payload.exp !== 'number' || !REASONS.includes(payload.reason)) return { ok: false, reason: 'bad_body' }
  const now = Math.floor(nowMs / 1000)
  if (payload.exp < now) return { ok: false, reason: 'expired' }
  if (payload.exp > now + MAX_EXP_AHEAD_S + 5) return { ok: false, reason: 'too_far' }
  return { ok: true, payload }
}

/** The text Postgres gives a jsonb value: keys by length then bytes, `": "` and `", "` as separators. */
export function pgJsonbText(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(pgJsonbText).join(', ')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${pgJsonbText(o[k])}`).join(', ')}}`
}

/** The address a slice posts its continuation to. */
export function continueUrl(): string {
  if (process.env.AGENT_CONTINUE_URL) return process.env.AGENT_CONTINUE_URL
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  return `${origin.replace(/\/$/, '')}/api/agent/continue`
}
