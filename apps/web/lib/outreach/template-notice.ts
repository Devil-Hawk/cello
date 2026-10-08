// What the user is told when a draft is the standard template and not a written
// draft: a title, and the reason with the next step. Client-safe, shared by the
// queue card and the contact panel's toast so the wording cannot drift.

import type { TemplateReason } from './types'

export const TEMPLATE_NOTICE_TITLE = 'Plain template, not a written draft'

const BODIES: Record<TemplateReason, string> = {
  missing_key: 'No model key is set. Add an OpenRouter key in Settings and draft again, or edit this one before sending.',
  spend_cap: "This month's spending cap is reached. Raise it in Settings or edit this one before sending.",
  provider_error: 'The model did not answer. Draft again in a few minutes, or edit this one before sending.',
  unusable_output: "The model's answer could not be used. Draft again, or edit this one before sending.",
}

/** Rows saved before the reason was recorded carry none; the notice still says what to do. */
const UNKNOWN_REASON = 'No model wrote this one. Draft again, or edit this one before sending.'

export function templateNotice(reason: TemplateReason | null | undefined): { title: string; body: string } {
  return { title: TEMPLATE_NOTICE_TITLE, body: reason ? BODIES[reason] : UNKNOWN_REASON }
}
