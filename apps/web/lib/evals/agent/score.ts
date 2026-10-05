// Scoring for the agent evals: plain code over what a model did, so a number means the same
// thing every run. Used by the live eval files and by score.test.ts.

import { parseJson } from './free.eval'

export interface ParsedCall {
  name: string
  args: Record<string, unknown>
}

/** What a first action is called for scoring: the tool name, 'read_file:<path>' for loading a skill, 'answer' for no tool. */
export function tokenOf(call: ParsedCall): string {
  if (call.name === 'read_file') return `read_file:${String(call.args.file_path ?? call.args.path ?? '')}`
  return call.name
}

export interface CaseSpec {
  id: string
  category: 'delegation' | 'single'
  message: string
  allowed_new: string[]
  allowed_old: string[]
}

/**
 * A first action passes when everything in it is allowed. Planning with write_todos first is a
 * correct move for a multi-step job, so it is ignored beside other calls, and counts as a pass
 * on its own only for a delegation case.
 */
export function passesNew(spec: Pick<CaseSpec, 'category' | 'allowed_new'>, calls: readonly ParsedCall[]): boolean {
  const tokens = calls.map(tokenOf)
  const substantive = tokens.filter((t) => t !== 'write_todos')
  if (tokens.length === 0) return spec.allowed_new.includes('answer')
  if (substantive.length === 0) return spec.category === 'delegation'
  return substantive.every((t) => spec.allowed_new.includes(t))
}

/** The earlier Copilot answered with one JSON object: a tool, a question, or a final answer. */
export function oldAction(text: string): string {
  const parsed = parseJson<{ action?: string; tool?: string }>(text)
  if (!parsed) return 'unparsed'
  if (parsed.action === 'tool') return typeof parsed.tool === 'string' ? parsed.tool : 'unparsed'
  return parsed.action === 'final' || parsed.action === 'ask' ? parsed.action : 'unparsed'
}

export const passesOld = (spec: Pick<CaseSpec, 'allowed_old'>, action: string): boolean => spec.allowed_old.includes(action)

/** A case passes when most of the models passed it. */
export function majority(passes: readonly boolean[]): boolean {
  return passes.filter(Boolean).length * 2 > passes.length
}

export interface Tally {
  overall: number
  delegation: number
  single: number
  perModel: Record<string, number>
  cases: number
}

/** Votes are those of the models that were measured. A model that errored has no vote, and a case no model measured counts as missed. */
export function tally(rows: readonly { category: string; byModel: Record<string, boolean> }[]): Tally {
  const wins = (r: { byModel: Record<string, boolean> }) => Object.keys(r.byModel).length > 0 && majority(Object.values(r.byModel))
  const share = (rs: typeof rows) => (rs.length === 0 ? 0 : rs.filter(wins).length / rs.length)
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.byModel)))]
  return {
    overall: share(rows),
    delegation: share(rows.filter((r) => r.category === 'delegation')),
    single: share(rows.filter((r) => r.category === 'single')),
    perModel: Object.fromEntries(
      models.map((m) => {
        const measured = rows.filter((r) => m in r.byModel)
        return [m, measured.length === 0 ? 0 : measured.filter((r) => r.byModel[m]).length / measured.length]
      })
    ),
    cases: rows.length,
  }
}
