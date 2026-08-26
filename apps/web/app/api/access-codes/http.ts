// Small shared pieces of the access-code routes' HTTP behaviour.
//
// Server-only: never import this from a client component.

/**
 * Every response on this surface is uncacheable.
 *
 * The create response carries a plaintext bearer credential, and the list and
 * trail responses describe who has been in a workspace. Neither belongs in a
 * shared cache, a CDN, or a back-button snapshot, and getting this wrong on one
 * route is easier than getting it wrong on all of them — so it is one constant.
 */
export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
} as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reject anything that is not a UUID before it reaches Postgres.
 *
 * Not a security boundary — RLS is — but a malformed id makes the uuid column
 * comparison raise 22P02, which surfaces as an opaque 500 instead of the 404
 * the caller actually deserves.
 */
export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value)
}
