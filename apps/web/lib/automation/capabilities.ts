// What Cello can actually DO right now, as opposed to what it has UI for.
//
// WHY THIS FILE EXISTS
//   Onboarding offered an "Auto-submit applications" switch. Turning it on
//   persisted `preferences.autoSubmit = true`, and the queue page then read
//   that back and displayed "Auto-submit applications: on". Nothing ever
//   submitted: lib/graph/autopilot.ts hardcodes `autoSubmit = false` and
//   always builds a pending_review draft instead. So the product asked for a
//   decision, confirmed the decision back to the user, and then silently did
//   the opposite — which is worse than not offering the switch at all, because
//   a user who believes applications are going out stops sending them.
//
//   The root cause was structural, not cosmetic: the UI and the engine each
//   encoded "can we auto-submit?" independently, so they were free to disagree.
//   This module is the single place that answers that question for the UI.
//
// THIS DOES NOT UNLOCK THE ENGINE — DELIBERATELY
//   Flipping AUTO_SUBMIT_AVAILABLE to true must NOT be sufficient to make
//   unattended submission happen. autopilot.ts keeps its own hardcoded `false`
//   precisely so that a mistake here cannot cause the cron path to start firing
//   irreversible, outward-facing actions at real employers on a user's behalf.
//   Submission stays gated on an explicit, server-enforced human confirmation
//   (lib/harness/chains.ts#buildSubmitConfirmedPlan). Two independent locks is
//   the correct arrangement for an action that cannot be undone.
//
//   The order to land real auto-submit is therefore: build and verify the
//   submission engine, then relax autopilot's own guard deliberately, and only
//   then flip this constant so the UI may offer it.

/**
 * May the UI offer unattended auto-submission as a real, working choice?
 *
 * False today. Cello can source, score, research, tailor a resume and stage a
 * complete application — but the final irreversible click is still a human's.
 */
export const AUTO_SUBMIT_AVAILABLE = false

/**
 * What to tell the user instead. Written as a statement of what DOES happen,
 * not an apology for what does not: "waits for your approval" is a promise
 * being kept, and reads that way.
 */
export const AUTO_SUBMIT_STATUS =
  'Cello prepares each application in full and holds it for your approval. Submitting is always your click.'

/**
 * Whether a stored preference should be treated as active. Old accounts may
 * already carry `autoSubmit: true` from when the switch was offered, so every
 * read path must fold the capability in rather than trusting the stored value.
 */
export function autoSubmitEnabled(storedPreference: unknown): boolean {
  return AUTO_SUBMIT_AVAILABLE && storedPreference === true
}
