// Chance: could this person win the role? Evidence, not a number.
//
// Each requirement of the posting is checked against the person's real resume
// and either shown on a cited line or reported as a gap. The label (Strong,
// Possible, Stretch) is a plain rule over those checks, and the gaps are named.
// A role whose posting cannot be read is "cannot assess yet", never a guess.
//
// The model proposes which resume line shows a requirement and quotes it. Code
// then confirms the quote is really on that line; a citation that is not is
// thrown away and the requirement counts as not shown.

import type { LlmRunner } from '@/lib/harness/types'
import { MissingKeyError, parseJsonLoose } from '@/lib/harness/llm'
import { BudgetCapError } from '@/lib/harness/spend'
import { quoteIsIn, type Requirement, type RequirementsOutcome } from './requirements'
import { scoringPromptRef, scoringSystem } from './prompts'
import type { ChanceResult, RequirementCheck, RoleFacts } from './types'

export interface ResumeLine {
  n: number
  text: string
}

const MAX_LINES = 220
const MAX_LINE_CHARS = 320
const ROLES_PER_CALL = 3

/** The resume as numbered, non-empty lines: the only thing a citation may point at. */
export function resumeLines(resumeText: string | null | undefined): ResumeLine[] {
  const out: ResumeLine[] = []
  for (const raw of (resumeText ?? '').split(/\r?\n/)) {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) continue
    out.push({ n: out.length + 1, text: text.slice(0, MAX_LINE_CHARS) })
    if (out.length >= MAX_LINES) break
  }
  return out
}

const STATUSES = ['met', 'partial', 'not_met'] as const

/** How many requirements the model claimed the resume shows, and how many of those citations held up. */
export interface CitationStats {
  claimed: number
  kept: number
}

/**
 * Confirms each citation. `met` and `partial` need a real line whose text holds
 * the quoted words; otherwise the requirement counts as not shown. A requirement
 * the model never answered stays `unclear`.
 */
export function verifyChecks(raw: unknown, requirements: readonly Requirement[], lines: readonly ResumeLine[], idOf: (r: Requirement) => string, stats?: CitationStats): RequirementCheck[] {
  const list = Array.isArray(raw) ? raw : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const item of list) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
      byId.set((item as Record<string, string>).id, item as Record<string, unknown>)
    }
  }
  return requirements.map((req): RequirementCheck => {
    const base = { requirement: req.text, mustHave: req.mustHave }
    const c = byId.get(idOf(req))
    if (!c) return { ...base, status: 'unclear', evidence: null }
    const status = (STATUSES as readonly string[]).includes(c.status as string) ? (c.status as (typeof STATUSES)[number]) : 'not_met'
    if (status === 'not_met') return { ...base, status, evidence: null }
    const line = typeof c.line === 'number' ? lines.find((l) => l.n === c.line) : undefined
    const quote = typeof c.quote === 'string' ? c.quote.trim() : ''
    if (stats) stats.claimed += 1
    if (!line || !quote || !quoteIsIn(quote, line.text)) return { ...base, status: 'not_met', evidence: null }
    if (stats) stats.kept += 1
    return { ...base, status, evidence: { line: line.n, quote: quote.slice(0, 200) } }
  })
}

/** Gaps that cannot be closed by wording on a resume: years of experience and licences. */
const HARD_KINDS: ReadonlySet<Requirement['kind']> = new Set(['experience', 'credential'])

/**
 * The label, as a rule anyone can read:
 *   Strong    every required item is shown on the resume (one partly shown at most per four).
 *   Stretch   two or more required items are not shown, or the one that is missing
 *             is years of experience or a licence.
 *   Possible  everything else: a gap or two that could be explained or closed.
 * A third or more of the requirements left unanswered is "cannot assess".
 *
 * Work authorization and where the person must be are facts only the person can
 * state, and a resume is usually silent on them. They never move the label: they
 * come back as `confirm` items for the person to check themselves, and the
 * constraints the person stated already filter on them.
 */
export function labelChance(reqs: readonly Requirement[], checks: readonly RequirementCheck[]): ChanceResult {
  const kindOf = new Map(reqs.map((r) => [r.text, r.kind]))
  const isPlace = (c: RequirementCheck) => kindOf.get(c.requirement) === 'authorization'
  const confirm = checks.filter(isPlace).map((c) => c.requirement)
  const scored = checks.filter((c) => !isPlace(c))
  const unclear = scored.filter((c) => c.status === 'unclear').length
  if (scored.length === 0 || unclear * 3 >= scored.length) {
    const note = checks.length > 0 && scored.length === 0 ? 'The posting only lists conditions you confirm yourself.' : 'Some requirements could not be checked just now.'
    return { chance: 'cannot_assess', checks: [...checks], gaps: [], confirm, note }
  }
  const must = scored.some((c) => c.mustHave) ? scored.filter((c) => c.mustHave) : [...scored]
  const unmet = must.filter((c) => c.status === 'not_met' || c.status === 'unclear')
  const partial = must.filter((c) => c.status === 'partial')

  let chance: ChanceResult['chance']
  if (unmet.length >= 2) chance = 'stretch'
  else if (unmet.length === 1) chance = HARD_KINDS.has(kindOf.get(unmet[0].requirement) ?? 'other') ? 'stretch' : 'possible'
  else chance = partial.length <= Math.max(1, Math.floor(must.length / 4)) ? 'strong' : 'possible'

  const gaps: string[] = []
  for (const c of unmet) gaps.push(c.requirement)
  for (const c of partial) gaps.push(`Only partly shown: ${c.requirement}`)
  for (const c of scored) if (!c.mustHave && c.status === 'not_met') gaps.push(`Nice to have: ${c.requirement}`)
  const shown = must.filter((c) => c.status === 'met').length
  return { chance, checks: [...checks], gaps: gaps.slice(0, 6), confirm, note: `${shown} of ${must.length} required items are shown on your resume.` }
}

export interface ChanceInput {
  role: RoleFacts
  outcome: RequirementsOutcome
}

function cannot(note: string): ChanceResult {
  return { chance: 'cannot_assess', checks: [], gaps: [], confirm: [], note }
}

/**
 * Checks several roles against one resume, three to a model call. Roles whose
 * posting could not be read come back as "cannot assess" without a call.
 */
export async function assessChances(llm: LlmRunner, resumeText: string, inputs: readonly ChanceInput[], stats?: CitationStats): Promise<Map<string, ChanceResult>> {
  const out = new Map<string, ChanceResult>()
  const lines = resumeLines(resumeText)
  const ready: { role: RoleFacts; reqs: Requirement[] }[] = []
  for (const { role, outcome } of inputs) {
    if (lines.length === 0) out.set(role.id, cannot('Add your resume so Cello can check the requirements against it.'))
    else if (outcome.kind === 'thin') out.set(role.id, cannot(`Cannot assess yet. ${outcome.reason}`))
    else if (outcome.kind === 'failed') out.set(role.id, cannot('Cannot assess yet. The posting could not be read just now.'))
    else ready.push({ role, reqs: outcome.requirements })
  }

  const resumeBlock = `Resume:\n${lines.map((l) => `[${l.n}] ${l.text}`).join('\n')}`
  for (let i = 0; i < ready.length; i += ROLES_PER_CALL) {
    const batch = ready.slice(i, i + ROLES_PER_CALL)
    const key = (k: number) => `j${k + 1}`
    const idOf = (k: number) => (r: Requirement) => `${key(k)}.${r.id}`
    const prompt = batch
      .map(
        ({ role, reqs }, k) =>
          `Role ${key(k)}: ${role.title} at ${role.company}\n` +
          reqs.map((r) => `${key(k)}.${r.id} (${r.mustHave ? 'must-have' : 'nice to have'}) ${r.text}`).join('\n')
      )
      .join('\n\n')
    try {
      const res = await llm({
        name: 'check-role-requirements',
        system: scoringSystem('role_chance', resumeBlock),
        prompt: `${prompt}\n\nCheck every requirement id against the resume.`,
        json: true,
        temperature: 0,
        maxTokens: 600 * batch.length + 1500,
        cachePrefix: true,
        promptRef: scoringPromptRef('role_chance'),
      })
      const parsed = parseJsonLoose<{ checks?: unknown }>(res.content)
      batch.forEach(({ role, reqs }, k) => {
        out.set(role.id, labelChance(reqs, verifyChecks(parsed.checks, reqs, lines, idOf(k), stats)))
      })
    } catch (err) {
      if (err instanceof MissingKeyError || err instanceof BudgetCapError) throw err
      for (const { role } of batch) out.set(role.id, cannot('Cannot assess yet. The check did not complete just now.'))
    }
  }
  return out
}
