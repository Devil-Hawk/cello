// The seams of the application pipeline: six functions that other work calls before the work
// behind them exists. Each takes and returns the shape its caller needs and throws until its
// owner builds it, so a caller can be written and tested against the type today and the body
// lands later without changing a caller.
//
//   advanceOne           take one application one step on its way (the pipeline)
//   answerArrived        a person answered a question that was holding an application (answers)
//   resolveFieldValues   the values for a form's fields, from what the person has told Cello (fill)
//   categorize           what a question is about (answers)
//   syncGmail            read job mail and apply what it says (delivery)
//   findSlice            read one slice of the roles an employer lists (finding)
//
// Nothing here is called by a page or a route yet.

import type { FieldCategory, FieldList, FillValues } from '@/lib/fill/contract'

const notBuilt = (name: string) => new Error(`Not built yet: ${name}`)

export interface AdvanceResult {
  /** Where the application is now, and when it is next due. */
  state: string
  next_at: string | null
}

export async function advanceOne(_userId: string, _applicationId: string): Promise<AdvanceResult> {
  throw notBuilt('advanceOne')
}

export async function answerArrived(_userId: string, _answerId: string): Promise<{ moved: number }> {
  throw notBuilt('answerArrived')
}

export async function resolveFieldValues(_userId: string, _applicationId: string, _fields: FieldList['fields']): Promise<FillValues> {
  throw notBuilt('resolveFieldValues')
}

export interface Categorized {
  category: FieldCategory
  /** True when the question asks about this employer or role, so a saved answer must not be reused. */
  specific: boolean
}

export async function categorize(_question: string): Promise<Categorized> {
  throw notBuilt('categorize')
}

export interface GmailSyncResult {
  matched: number
  suggested: number
}

export async function syncGmail(_userId: string): Promise<GmailSyncResult> {
  throw notBuilt('syncGmail')
}

export interface Slice {
  employerId: string
  /** Where the read stopped last time, so the next call carries on. */
  cursor?: string | null
}

export interface SliceResult {
  found: number
  kept: number
  cursor: string | null
}

export async function findSlice(_userId: string, _slice: Slice): Promise<SliceResult> {
  throw notBuilt('findSlice')
}
