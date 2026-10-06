// What is wrong with a resume's format, found by code from the structured resume. Nothing here
// is a model's opinion and nothing is a score: each line names the thing to fix.

import { COLUMNS_WARNING } from './import/infer'
import type { Resume } from './schema'

/** Under this many words a resume gives Cello too little to check a role against. */
export const THIN_WORDS = 150
const LONG_WORDS = 900

export const wordCount = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0)

const hasDate = (e: { startDate?: string; endDate?: string; dateLabel?: string; current?: boolean }) =>
  Boolean(e.startDate || e.endDate || e.dateLabel || e.current)

export function formatFixes(resume: Resume, plainText: string): string[] {
  const fixes: string[] = []
  for (const w of resume.work) if (!hasDate(w)) fixes.push(`Add dates to ${w.position} at ${w.name}.`)
  for (const e of resume.education) if (!hasDate(e)) fixes.push(`Add dates to ${e.institution}.`)
  if (!resume.basics.email && !resume.basics.phone) fixes.push('Add an email or phone under your name.')
  if (resume.meta.cello.warnings.includes(COLUMNS_WARNING)) fixes.push(COLUMNS_WARNING)
  if (wordCount(plainText) > LONG_WORDS) fixes.push('Over two pages. Most roles want one or two.')
  return fixes
}

/** The thin-resume line, or null when there is enough to work with. */
export function resumeHealth(words: number): string | null {
  return words < THIN_WORDS
    ? `${words} words. Too thin for chance checks: add 3 to 5 bullet points per role, with outcomes.`
    : null
}
