// May Send for me send this application without a click? Points 5 and 6 of the rule, in code (the rest
// is SQL: pipeline_auto_send_reason and the claim). It answers with the one sentence the row shows, or
// null. It runs when a row is read, before the claim, against the live form, and at ready_to_send; at
// fill time it can only stop a send.
//
// What may be sent: values from the person's profile facts and answers the person gave themselves
// (origin person, by exact key). Never an answer a model wrote, even one the person approved or
// confirmed; never one read from the resume by code; never a similar answer; never a demographic or a
// consent. And only on a host on auto-hosts, which is empty until the owner has watched a real send.

import type { Category, FieldKind } from '@/lib/answers/categories'
import type { Resolved } from '@/lib/answers'
import { AUTO_HOSTS, type AutoHost } from './auto-hosts'

export interface EligibleField {
  label: string
  category: Category
  kind: FieldKind
  required: boolean
  options?: string[] | null
  /** What resolveFieldValues gave for it, if anything. */
  resolved?: Resolved
}

export function eligibility(input: { company: string; url: string; fields: readonly EligibleField[]; hosts?: readonly AutoHost[] }): string | null {
  for (const f of input.fields) {
    if (f.required && f.category === 'consent') return `${input.company}'s form asks you to agree to something. Send this one yourself.`
    if (f.required && f.category === 'eeo') return 'A required question about you is for you to answer. Send this one yourself.'
    const r = f.resolved
    if (!r) {
      if (f.required) return 'A required question has no answer yet.'
      continue
    }
    // every value the form would get, required or not: the extension fills all of them
    if (r.via === 'similar') return 'Cello used a similar saved answer here. Confirm it to let Cello send this.'
    if (r.origin === 'code') return 'Cello read an answer from your resume. Answer it yourself to let Cello send this.'
    if (r.origin === 'model') return 'Answer it yourself to let Cello send this.'
    if (f.options?.length && (typeof r.value !== 'string' || !f.options.some((o) => o.trim().toLowerCase() === (r.value as string).trim().toLowerCase()))) {
      return "An answer does not match the form's choices. Send this one yourself."
    }
  }
  let host = ''
  try {
    host = new URL(input.url).hostname.toLowerCase()
  } catch {
    // an address that does not parse is not on the list
  }
  if (!(input.hosts ?? AUTO_HOSTS).some((h) => h.host === host)) return 'Cello cannot send on this site yet. Open it and click Fill.'
  return null
}
