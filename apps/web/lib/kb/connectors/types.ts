// Shared result type for the KB connector layer (lib/kb/connectors/*).
//
// A connector performs ONE sync attempt against a kb_sources row and returns a
// KbSyncOutcome — it NEVER throws. This lets every caller (the sync route, the
// documents route) treat "not configured / not enabled yet" (disabled) and
// "the sync itself failed" (error) as distinct, always-recordable outcomes
// instead of a raw exception that would 500 the route and hide the reason
// from the user. See app/api/kb/sources/[id]/sync/route.ts, which persists
// every outcome via lib/kb/store.ts recordSync() — last_synced_at on success,
// last_error otherwise — so failures (including "disabled") stay visible in
// the UI across reloads instead of failing quietly.

export type KbSyncOutcome =
  | { status: 'synced'; documentsWritten: number; chunksWritten: number; message: string }
  /**
   * Not attempted: missing config (no URL/actor id), no BYOK token, the
   * source's own `enabled` flag is off, or there is simply nothing to sync
   * yet (an empty paste source). Not a "failure" in the exceptional sense —
   * a clearly labeled, expected state the UI shows plainly rather than as an
   * error toast.
   */
  | { status: 'disabled'; message: string }
  /** Attempted and failed: network/timeout/upstream/validation error. */
  | { status: 'error'; message: string }
