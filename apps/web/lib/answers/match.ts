// Finding a saved answer for a question: the exact key first, then a guarded similarity match. The
// guards are the point. A similar question is never the same question when it is sensitive, names a
// place, a company, a number of days, a date or an amount, or is shaped differently, so "willing to
// relocate to Austin" never takes the answer for London and "onsite 3 days" never takes 5.

import type { Category, FieldKind } from './categories'
import { similarity } from './normalize'

export const SIMILARITY_MIN = 0.8

export interface BankRow {
  id: string
  question: string
  question_key: string
  category: Category
  sensitive: boolean
  specific: boolean
  kind: FieldKind
  options: string[] | null
  answer: unknown
  declined: boolean
  company_id: string | null
  source: 'person' | 'profile' | 'resume' | 'approved_draft' | 'chat'
  source_ref: { application_id?: string } | null
  origin: 'person' | 'code' | 'model'
  confirmed_at: string | null
  updated_at?: string
}

export interface Asked {
  key: string
  category: Category
  sensitive: boolean
  specific: boolean
  kind: FieldKind
  options: string[] | null
}

export interface Scope {
  companyId: string | null
  applicationId: string | null
}

export type Found = { row: BankRow; via: 'exact' | 'similar'; score: number }

const sameSet = (a: string[] | null, b: string[] | null) => {
  if (!a && !b) return true
  if (!a || !b || a.length !== b.length) return false
  const x = new Set(a.map((s) => s.trim().toLowerCase()))
  return b.every((s) => x.has(s.trim().toLowerCase()))
}

/** A saved answer may be used for this question: it has a value, belongs to this employer or none, and a long answer written for one application stays with it. */
function usable(r: BankRow, scope: Scope): boolean {
  if (r.answer === null || r.answer === undefined || r.declined) return false
  if (r.company_id && r.company_id !== scope.companyId) return false
  const long = r.kind === 'long_text' || r.category === 'motivation' || r.category === 'other'
  const wroteFor = r.source_ref?.application_id
  if (long && wroteFor && wroteFor !== scope.applicationId) return false
  return true
}

export function findAnswer(rows: readonly BankRow[], asked: Asked, scope: Scope): Found | null {
  const ok = rows.filter((r) => usable(r, scope))

  // the exact key: this employer's own row before the general one
  const exact = ok.filter((r) => r.question_key === asked.key).sort((a, b) => Number(Boolean(b.company_id)) - Number(Boolean(a.company_id)))[0]
  if (exact) return { row: exact, via: 'exact', score: 1 }

  // similarity: never for a sensitive or specific question, and the saved one must be neither too
  if (asked.sensitive || asked.specific) return null
  let best: Found | null = null
  for (const r of ok) {
    if (r.sensitive || r.specific || r.category !== asked.category || r.kind !== asked.kind || !sameSet(r.options, asked.options)) continue
    const score = similarity(r.question_key, asked.key)
    if (score >= SIMILARITY_MIN && (!best || score > best.score)) best = { row: r, via: 'similar', score }
  }
  return best
}
