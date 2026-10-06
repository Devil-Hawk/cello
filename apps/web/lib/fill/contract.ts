// The contract between the server and the browser extension that fills an employer's form.
//
// The extension calls only the routes this file describes. The server serves them, and the
// extension never learns more than it needs: it sends the list of fields the form asks for, it
// gets back values for those fields only, and it reports what happened. Nothing here sends or
// submits anything; it only says what may be said about a form.
//
// What may be read back from a form is the allowlist at the bottom: never a password, a hidden
// input, a file's bytes or a challenge input, and for the sensitive categories only that the
// person answered it themselves.

import { z } from 'zod'

// --- the fields of a form ---------------------------------------------------------

export const FIELD_KINDS = ['text', 'textarea', 'select', 'radio', 'checkbox', 'date', 'number', 'file', 'password', 'hidden', 'challenge'] as const
export type FieldKind = (typeof FIELD_KINDS)[number]

/** What a question is about. Code decides it from the label; a model may only pick one of these. */
export const FIELD_CATEGORIES = ['name', 'email', 'phone', 'location', 'links', 'work_auth', 'sponsorship', 'salary', 'eeo', 'consent', 'motivation', 'other'] as const
export type FieldCategory = (typeof FIELD_CATEGORIES)[number]

const Key = z.string().min(1).max(200)

export const FieldSchema = z.object({
  key: Key,
  label: z.string().max(500),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean(),
  category: z.enum(FIELD_CATEGORIES).optional(),
  /** The options of a select or a radio group, as the page shows them. */
  options: z.array(z.string().max(300)).max(200).optional(),
})
export type Field = z.infer<typeof FieldSchema>

/** What the extension sends when it opens a form: every field the form asks for. */
export const FieldList = z.object({
  application_id: z.string().min(1),
  url: z.string().url(),
  fields: z.array(FieldSchema).max(300),
})
export type FieldList = z.infer<typeof FieldList>

// --- values to fill ---------------------------------------------------------------

const Value = z.union([z.string().max(10_000), z.boolean(), z.array(z.string().max(300)).max(50)])

/** What the server hands back: a value for a field of the session's list, or nothing for a field it does not know. */
export const FillValues = z.object({
  application_id: z.string().min(1),
  /** Keyed by field key. A key that is not in the session's field list is dropped by the server. */
  values: z.record(Key, Value),
  /** Required fields the server has no value for. They stay empty and the person is told. */
  unknown: z.array(Key).default([]),
})
export type FillValues = z.infer<typeof FillValues>

// --- reading values back ----------------------------------------------------------

export const ANSWERED_BY_YOU_CATEGORIES: readonly FieldCategory[] = ['work_auth', 'sponsorship', 'salary', 'eeo', 'consent']
export const NEVER_READ_KINDS: readonly FieldKind[] = ['password', 'hidden', 'challenge']

export type ReadBack = 'value' | 'answered_by_you' | 'file_name' | 'never'

/**
 * What may be recorded for a field after the form is filled. The read-back allowlist: never a
 * password, a hidden input or a challenge input; for a file only the name Cello attached; for the
 * sensitive categories only that the person answered it; everything else, its value.
 */
export function readBackFor(field: { kind: FieldKind; category?: FieldCategory }): ReadBack {
  if (NEVER_READ_KINDS.includes(field.kind)) return 'never'
  if (field.kind === 'file') return 'file_name'
  if (field.category && ANSWERED_BY_YOU_CATEGORIES.includes(field.category)) return 'answered_by_you'
  return 'value'
}

const ReadBackEntry = z.union([
  z.object({ answered_by_you: z.literal(true) }).strict(),
  z.object({ file_name: z.string().max(300) }).strict(),
  z.object({ value: Value }).strict(),
])

// The category here comes from the extension. The fill route must take it from the server's own
// session field list, so a sensitive field reported without one is never accepted as a plain value.
const ReadBackField = z.object({
  key: Key,
  kind: z.enum(FIELD_KINDS),
  category: z.enum(FIELD_CATEGORIES).optional(),
  entry: ReadBackEntry,
})

// --- what happened ----------------------------------------------------------------

export const PHASES = ['filled', 'blocked', 'ready_to_send', 'submitted', 'confirmation', 'unconfirmed', 'abandoned'] as const
export type Phase = (typeof PHASES)[number]

/** Why the extension stopped and handed the form to the person. */
export const STOP_CAUSES = [
  'sign_in',
  'account',
  'site_check',
  'unreadable',
  'unknown_field',
  'prefilled',
  'wrong_page',
  'upload',
  'form_changed',
  'no_submit',
  'form_error',
  'interrupted',
] as const
export type StopCause = (typeof STOP_CAUSES)[number]

/** The site's own confirmation, seen after a submit. Only this makes something Sent by Cello. */
export const Confirmation = z.object({
  text: z.string().max(2000),
  url: z.string().url(),
  seen_at: z.string().min(1),
  /** The confirmation id the page shows, when it shows one. */
  reference: z.string().max(200).optional(),
})
export type Confirmation = z.infer<typeof Confirmation>

export const FillReport = z
  .object({
    application_id: z.string().min(1),
    phase: z.enum(PHASES),
    cause: z.enum(STOP_CAUSES).optional(),
    final_url: z.string().url().optional(),
    /** Read back from the form, through the allowlist. Present from ready_to_send on. */
    values: z.array(ReadBackField).max(300).optional(),
    confirmation: Confirmation.optional(),
  })
  .superRefine((report, ctx) => {
    if (report.phase === 'blocked' && !report.cause) ctx.addIssue({ code: 'custom', path: ['cause'], message: 'A blocked form says why.' })
    if (report.phase === 'confirmation' && !report.confirmation) ctx.addIssue({ code: 'custom', path: ['confirmation'], message: 'A confirmation carries what the site showed.' })
    for (const [i, f] of (report.values ?? []).entries()) {
      const allowed = readBackFor(f)
      const given = 'answered_by_you' in f.entry ? 'answered_by_you' : 'file_name' in f.entry ? 'file_name' : 'value'
      if (allowed === 'never') ctx.addIssue({ code: 'custom', path: ['values', i], message: `A ${f.kind} field is never read back.` })
      else if (given !== allowed) ctx.addIssue({ code: 'custom', path: ['values', i], message: `A ${f.category ?? f.kind} field is recorded as ${allowed}.` })
    }
  })
export type FillReport = z.infer<typeof FillReport>

// --- the next application to fill -------------------------------------------------

/** The answer to the extension's question "is there anything for me to do": one application, or none. */
export const FillNext = z.object({
  application: z.object({ id: z.string().min(1), url: z.string().url() }).nullable(),
})
export type FillNext = z.infer<typeof FillNext>
