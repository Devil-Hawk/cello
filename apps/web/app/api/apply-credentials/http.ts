// Shared HTTP behaviour for the apply-credential routes.
//
// Server-only: never import this from a client component.

import { NextResponse } from 'next/server'
import { VaultError, type VaultRefusal } from '@/lib/apply/vault'

/**
 * Nothing on this surface is cacheable.
 *
 * The request bodies carry passwords and the responses describe which employers
 * a person holds accounts with. Neither belongs in a shared cache, a CDN, or a
 * back-button snapshot — and getting it right on one route but not another is
 * the easy mistake, so it is one constant.
 */
export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
} as const

/**
 * How each refusal reaches the client.
 *
 * 'encryption-unavailable' is a 503, not a 400 or a 500: nothing the caller
 * sent is wrong, and it is not a transient bug — the deployment is misconfigured
 * and the operator has to do something. A 503 is the status that says "this
 * service cannot do this right now", which is the truth, and it stops a client
 * from retrying the same password into the same hole.
 */
const STATUS: Record<VaultRefusal, number> = {
  'encryption-unavailable': 503,
  'profile-unavailable': 403,
  'demo-forbidden': 403,
  'invalid-input': 400,
  'not-found': 404,
  'storage-failed': 500,
  'decrypt-failed': 500,
}

/**
 * Turn any thrown value into a response.
 *
 * A VaultError's message is written to be user-safe and secret-free (see
 * lib/apply/vault.ts), so it is passed through. ANYTHING ELSE IS REPLACED
 * WHOLESALE — an unexpected throw could be a driver error carrying the row it
 * was working on, and this surface's rows are passwords. The original is not
 * logged either, for the same reason; the route logs the fact and the shape,
 * never the value.
 */
export function vaultErrorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof VaultError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: STATUS[error.code] ?? 500, headers: NO_STORE }
    )
  }

  console.error(`[apply-credentials] ${context}: unexpected ${describeShape(error)}`)
  return NextResponse.json(
    { error: 'Something went wrong. Try again.' },
    { status: 500, headers: NO_STORE }
  )
}

/** The TYPE of an unexpected throw, never its content. */
function describeShape(error: unknown): string {
  if (error instanceof Error) return `${error.name}`
  return typeof error
}
