// What Cello never fills, whatever is saved. Demographics and consents are the person's alone: they
// choose on the page and the choice is never read back. Anything else a person may answer is saved
// once by the person and reused by exact key; it is never produced by a model.

import type { Category } from './categories'

/** Categories Cello leaves blank for the person on every form. */
const NEVER_FILLED: readonly Category[] = ['eeo', 'consent']

// A question about a person's own history that no profile fact answers.
const OWN_HISTORY = /\b(worked (here|for us|at)|previously (employed|worked)|former employee|currently employed (by|at)|relative|related to)\b/i

export function neverFilled(category: Category): boolean {
  return NEVER_FILLED.includes(category)
}

/** Questions only the person's own saved answer (exact key) may fill; no similarity, no code. */
export function personOnly(question: string, category: Category): boolean {
  return category === 'salary' || category === 'start_date' || category === 'notice' || OWN_HISTORY.test(question) || /\breference\b/i.test(question)
}
