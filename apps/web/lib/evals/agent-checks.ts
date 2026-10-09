// The checks the agent evals run over a model's answer, and the shape of a skill's evals.json.
// They are plain code on purpose: the answer is judged by rules written down in the file next to
// the skill, so a failure says which rule broke, and the same rules run in the unit test and in the
// live run against free models (scripts/evals/agent/run-skills.ts).

import { z } from 'zod'

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('matches'), pattern: z.string(), flags: z.string().optional(), note: z.string() }),
  z.object({ type: z.literal('not_matches'), pattern: z.string(), flags: z.string().optional(), note: z.string() }),
  z.object({ type: z.literal('min_words'), value: z.number().int().positive(), note: z.string() }),
  z.object({ type: z.literal('max_words'), value: z.number().int().positive(), note: z.string() }),
  /** The text before the first `marker` must not match. A missing marker leaves all of the text before it. */
  z.object({ type: z.literal('before_not_matches'), marker: z.string(), pattern: z.string(), flags: z.string().optional(), note: z.string() }),
  /** The text after the first `marker` must match. A missing marker fails the check. */
  z.object({ type: z.literal('after_matches'), marker: z.string(), pattern: z.string(), flags: z.string().optional(), note: z.string() }),
  /** Every URL in the text is one of these. */
  z.object({ type: z.literal('urls_subset'), allowed: z.array(z.string()), note: z.string() }),
])
export type Check = z.infer<typeof CheckSchema>

export const SkillEvalsSchema = z.object({
  skill: z.string(),
  trigger: z.array(z.object({ id: z.string(), message: z.string().min(5), load: z.boolean() })).length(3),
  output: z.array(z.object({ id: z.string(), message: z.string().min(20), checks: z.array(CheckSchema).min(2) })).min(1),
})
export type SkillEvals = z.infer<typeof SkillEvalsSchema>

export interface CheckResult {
  ok: boolean
  note: string
  type: Check['type']
}

const words = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0)
const urls = (text: string): string[] => (text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, ''))

export function runCheck(check: Check, text: string): CheckResult {
  const re = (pattern: string, flags?: string) => new RegExp(pattern, flags)
  let ok: boolean
  switch (check.type) {
    case 'matches':
      ok = re(check.pattern, check.flags).test(text)
      break
    case 'not_matches':
      ok = !re(check.pattern, check.flags).test(text)
      break
    case 'min_words':
      ok = words(text) >= check.value
      break
    case 'max_words':
      ok = words(text) <= check.value
      break
    case 'before_not_matches': {
      const at = text.indexOf(check.marker)
      ok = !re(check.pattern, check.flags).test(at >= 0 ? text.slice(0, at) : text)
      break
    }
    case 'after_matches': {
      const at = text.indexOf(check.marker)
      ok = at >= 0 && re(check.pattern, check.flags).test(text.slice(at + check.marker.length))
      break
    }
    case 'urls_subset':
      ok = urls(text).every((u) => check.allowed.includes(u))
      break
  }
  return { ok, note: check.note, type: check.type }
}

export function runChecks(checks: readonly Check[], text: string): { passed: number; total: number; failures: CheckResult[] } {
  const results = checks.map((c) => runCheck(c, text))
  return { passed: results.filter((r) => r.ok).length, total: results.length, failures: results.filter((r) => !r.ok) }
}

/** The skill files a first action read, from the `file_path` of its read_file calls. */
export function skillsRead(calls: readonly { name: string; args: Record<string, unknown> }[]): string[] {
  const out: string[] = []
  for (const c of calls) {
    if (c.name !== 'read_file') continue
    const p = String(c.args.file_path ?? c.args.path ?? '')
    const m = /^\/skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(p)
    if (m) out.push(m[1])
  }
  return out
}
