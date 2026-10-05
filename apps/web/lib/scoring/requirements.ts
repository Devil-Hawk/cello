// The shared requirements extractor: what a posting says a candidate needs, as
// short checkable statements each tied to a verbatim quote.
//
// A posting with no usable description is "thin": there is nothing to check a
// resume against, and the honest answer is "cannot assess yet". That is decided
// here in code, before any model is asked. For a posting with a description the
// model proposes the list, and code throws away every item whose quote is not
// really in the posting, so an invented requirement cannot survive.

import type { LlmRunner } from '@/lib/harness/types'
import { MissingKeyError, parseJsonLoose } from '@/lib/harness/llm'
import { BudgetCapError } from '@/lib/harness/spend'
import { frameJobTextList } from '@/lib/security/job-text'
import { scoringPromptRef, scoringSystem } from './prompts'
import type { RoleFacts } from './types'

/** Bump when the prompt or the grounding rules change, so stored requirements are re-read. */
export const EXTRACTOR_VERSION = 1

export const REQUIREMENT_KINDS = ['skill', 'experience', 'domain', 'education', 'credential', 'authorization', 'language', 'other'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

export interface Requirement {
  id: string
  text: string
  kind: RequirementKind
  mustHave: boolean
  quote: string
}

export type RequirementsOutcome =
  | { kind: 'ok'; requirements: Requirement[] }
  /** The posting says too little to check anyone against. Not an error. */
  | { kind: 'thin'; reason: string }
  /** The model did not give a usable answer this time. Try again later; do not cache. */
  | { kind: 'failed'; reason: string }

/** Under this many characters a posting is a title and a sentence, not a description. */
export const MIN_DESCRIPTION_CHARS = 200
/** Fewest grounded requirements for a posting to count as readable. */
export const MIN_REQUIREMENTS = 2
const MAX_REQUIREMENTS = 12
const BATCH_SIZE = 4
const DESCRIPTION_CHARS = 5000

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `quote` appears in `text`, ignoring case, spacing and curly punctuation. */
export function quoteIsIn(quote: string, text: string): boolean {
  const q = fold(quote)
  return q.length >= 6 && fold(text).includes(q)
}

function asKind(v: unknown): RequirementKind {
  return (REQUIREMENT_KINDS as readonly string[]).includes(v as string) ? (v as RequirementKind) : 'other'
}

/** How many items the model proposed and how many survived the check that their quote is really in the posting. */
export interface GroundingStats {
  proposed: number
  grounded: number
}

/**
 * Turns the model's answer for one posting into grounded requirements. Items
 * with no verbatim quote in the posting are dropped; duplicates are merged.
 */
export function groundRequirements(raw: unknown, description: string, stats?: GroundingStats): RequirementsOutcome {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (o.enough_detail === false) return { kind: 'thin', reason: 'The posting does not list what the role needs.' }
  const list = Array.isArray(o.requirements) ? o.requirements : []
  const seen = new Set<string>()
  const out: Requirement[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    const quote = typeof r.quote === 'string' ? r.quote.trim() : ''
    if (stats) stats.proposed += 1
    if (!text || !quote) continue
    if (!quoteIsIn(quote, description)) continue
    if (stats) stats.grounded += 1
    const key = fold(text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: `r${out.length + 1}`, text: text.slice(0, 160), kind: asKind(r.kind), mustHave: r.must_have !== false, quote: quote.slice(0, 200) })
    if (out.length >= MAX_REQUIREMENTS) break
  }
  if (out.length < MIN_REQUIREMENTS) return { kind: 'thin', reason: 'The posting names too few requirements to check a resume against.' }
  return { kind: 'ok', requirements: out }
}

/** A posting with no usable description needs no model to be called "cannot assess yet". */
export function descriptionIsThin(description: string | null | undefined): boolean {
  return (description ?? '').trim().length < MIN_DESCRIPTION_CHARS
}

/**
 * Reads the requirements of several postings, four to a model call. Postings
 * that are thin are answered without a call. Never throws on a model failure:
 * the affected postings come back as `failed`.
 */
export async function extractRequirements(llm: LlmRunner, roles: readonly RoleFacts[], stats?: GroundingStats): Promise<Map<string, RequirementsOutcome>> {
  const out = new Map<string, RequirementsOutcome>()
  const toRead: RoleFacts[] = []
  for (const r of roles) {
    if (descriptionIsThin(r.description)) out.set(r.id, { kind: 'thin', reason: 'The posting has no description yet.' })
    else toRead.push(r)
  }

  for (let i = 0; i < toRead.length; i += BATCH_SIZE) {
    const batch = toRead.slice(i, i + BATCH_SIZE)
    const ids = batch.map((_, k) => `p${k + 1}`)
    const prompt =
      frameJobTextList(
        batch.map((r, k) => ({ id: ids[k], text: `${r.title} at ${r.company}\n\n${r.description}` })),
        { label: 'POSTING', maxChars: DESCRIPTION_CHARS }
      ) + '\n\nList the requirements of each posting.'
    try {
      const res = await llm({
        name: 'extract-role-requirements',
        system: scoringSystem('role_requirements'),
        prompt,
        json: true,
        temperature: 0.1,
        maxTokens: 900 * batch.length + 1500,
        promptRef: scoringPromptRef('role_requirements'),
      })
      const parsed = parseJsonLoose<{ postings?: { id?: string }[] }>(res.content)
      const byId = new Map((parsed.postings ?? []).map((p) => [String(p.id), p]))
      batch.forEach((r, k) => {
        const p = byId.get(ids[k])
        out.set(r.id, p ? groundRequirements(p, r.description ?? '', stats) : { kind: 'failed', reason: 'The model skipped this posting.' })
      })
    } catch (err) {
      // No key or no budget is not a bad answer for these postings; the caller has to hear it.
      if (err instanceof MissingKeyError || err instanceof BudgetCapError) throw err
      const reason = err instanceof Error ? err.message : String(err)
      for (const r of batch) out.set(r.id, { kind: 'failed', reason })
    }
  }
  return out
}
