// Claim-level judges for written drafts. Both read numbered source lines and
// return ids that code re-checks, so a judge cannot pass a draft by waving at
// "the resume": a cited id has to exist, a cited number has to be on the cited
// line, and a specificity detail has to share a content word with its line.
//
// They run through callLlm (the one door: spend reserve and settle, tracing,
// the free-model fallback) and use a model from a different family than the one
// that wrote the draft.

import type { DecryptedApiKeys, LlmRunner } from '../harness/types'
import { callLlm } from '../harness/llm'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { DEFAULT_MODEL } from '../harness/providers/openrouter'
import { formatLines, type NumberedLine } from '../resume/lines'
import { frameJobText } from '../security/job-text'
import type { EvalResult } from './harness'

export const GROUNDED_THRESHOLD = 1
export const SPECIFIC_THRESHOLD = 1

/** A judge from a different model family than the writer. */
export function judgeModelFor(writerModel: string): string {
  return writerModel.startsWith('anthropic/') ? 'google/gemini-2.5-flash' : 'anthropic/claude-haiku-4.5'
}

/** callLlm bound to the judge model, with the writer's family kept out. */
export function judgeRunner(apiKeys: DecryptedApiKeys, name: string): LlmRunner {
  return (opts) =>
    callLlm(apiKeys, {
      ...opts,
      model: judgeModelFor(apiKeys.model ?? DEFAULT_MODEL),
      json: true,
      temperature: 0,
      maxTokens: 900,
      reasoning: { effort: 'none' },
      name,
    })
}

export type ClaimStatus = 'supported' | 'unsupported' | 'contradicted'
export interface JudgedClaim {
  text: string
  about: string
  source: string | null
  status: ClaimStatus
}

export interface ClaimsResult extends EvalResult {
  claims: JudgedClaim[]
  /** The claims no source line backs, ready for a card and a corrective prompt. */
  unsupported: JudgedClaim[]
}

export interface SpecificityResult extends EvalResult {
  detail: string | null
  source: string | null
}

function parse(content: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return tryParse(content.trim()) ?? tryParse(content.match(/\{[\s\S]*\}/)?.[0] ?? '')
}

const NUMBER = /\d[\d,.]*/g
function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/[,.]+$/, '').replace(/,/g, ''))
}

function sourcesBlock(lines: NumberedLine[], extra?: (l: NumberedLine) => string): string {
  const resume = lines.filter((l) => l.id.startsWith('R'))
  const rest = lines.filter((l) => !l.id.startsWith('R'))
  const parts: string[] = []
  if (resume.length) parts.push(formatLines(resume))
  // Employer text and scraped company pages are third-party writing: fenced as data.
  for (const [prefix, label] of [
    ['J', 'JOB POST'],
    ['D', 'COMPANY RESEARCH'],
    ['H', 'MESSAGE HISTORY'],
  ] as const) {
    const group = rest.filter((l) => l.id.startsWith(prefix))
    if (!group.length) continue
    const text = group.map((l) => (extra ? extra(l) : `${l.id}: ${l.text}`)).join('\n')
    parts.push(prefix === 'H' ? text : frameJobText(text, { label, maxChars: 14_000 }))
  }
  return parts.join('\n\n')
}

export interface ClaimsInput {
  text: string
  /** R, J, D and H lines, in any mix. */
  sources: NumberedLine[]
}

export async function judgeClaims(run: LlmRunner, input: ClaimsInput): Promise<ClaimsResult> {
  const refuse = (summary: string): ClaimsResult => ({
    name: 'groundedness',
    verdict: 'insufficient-data',
    score: null,
    threshold: GROUNDED_THRESHOLD,
    n: 0,
    summary,
    claims: [],
    unsupported: [],
  })

  const res = await run({
    system: composeSystemPrompt({ mode: loadModeDoc('judge_claims'), includeVoice: false }),
    promptRef: promptRef('judge_claims'),
    prompt: `<draft>\n${input.text.trim()}\n</draft>\n\n<sources>\n${sourcesBlock(input.sources)}\n</sources>`,
    json: true,
    maxTokens: 900,
    temperature: 0,
  })
  const parsed = parse(res.content)
  const raw = parsed && Array.isArray(parsed.claims) ? parsed.claims : null
  if (!raw) return refuse('The check could not read the model answer, so this was not checked.')
  if (raw.length === 0) return refuse('The check found no statements to verify, so this was not checked.')

  const byId = new Map(input.sources.map((l) => [l.id, l]))
  const claims: JudgedClaim[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    if (!text) continue
    const source = typeof r.source === 'string' ? r.source.trim().toUpperCase() : null
    let status: ClaimStatus = r.status === 'supported' || r.status === 'contradicted' ? r.status : 'unsupported'
    if (status === 'supported') {
      const line = source ? byId.get(source) : undefined
      // A supported claim must cite a line that exists and carry its numbers.
      if (!line) status = 'unsupported'
      else if (numbersIn(text).some((n) => !numbersIn(line.text).includes(n))) status = 'unsupported'
    }
    claims.push({ text, about: typeof r.about === 'string' ? r.about : 'sender', source: status === 'supported' ? source : null, status })
  }
  if (claims.length === 0) return refuse('The check found no statements to verify, so this was not checked.')

  const unsupported = claims.filter((c) => c.status !== 'supported')
  const score = (claims.length - unsupported.length) / claims.length
  return {
    name: 'groundedness',
    verdict: unsupported.length === 0 ? 'pass' : 'fail',
    score,
    threshold: GROUNDED_THRESHOLD,
    n: claims.length,
    summary:
      unsupported.length === 0
        ? `All ${claims.length} statements trace to your sources.`
        : unsupported.map((c) => `Not in your sources: "${c.text}"`).join(' '),
    claims,
    unsupported,
  }
}

const STOP = new Set(['that', 'this', 'with', 'from', 'your', 'have', 'will', 'their', 'about', 'which', 'what', 'were', 'been', 'more', 'also', 'into', 'than', 'they', 'them', 'role', 'team'])
function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))
}

export interface SpecificityInput {
  text: string
  jobLines: NumberedLine[]
  /** Company facts as D lines; `url` is shown to the judge and kept for the card. */
  facts: (NumberedLine & { url?: string })[]
  role: string
  company: string
}

export async function judgeSpecificity(run: LlmRunner, input: SpecificityInput): Promise<SpecificityResult> {
  const sources = [...input.jobLines, ...input.facts]
  if (sources.length === 0) {
    return {
      name: 'specificity',
      verdict: 'insufficient-data',
      score: null,
      threshold: SPECIFIC_THRESHOLD,
      n: 0,
      summary: 'Nothing about this role or company is on file, so this could not be checked.',
      detail: null,
      source: null,
    }
  }
  const res = await run({
    system: composeSystemPrompt({ mode: loadModeDoc('judge_specificity'), includeVoice: false }),
    promptRef: promptRef('judge_specificity'),
    prompt:
      `<draft>\n${input.text.trim()}\n</draft>\n\n<role>${input.role}, ${input.company}</role>\n\n<sources>\n` +
      `${sourcesBlock(sources, (l) => `${l.id}: ${l.text}${'url' in l && l.url ? ` (${l.url})` : ''}`)}\n</sources>`,
    json: true,
    maxTokens: 600,
    temperature: 0,
  })
  const parsed = parse(res.content)
  if (!parsed || typeof parsed.specific !== 'boolean') {
    return {
      name: 'specificity',
      verdict: 'insufficient-data',
      score: null,
      threshold: SPECIFIC_THRESHOLD,
      n: 0,
      summary: 'The check could not read the model answer, so this was not checked.',
      detail: null,
      source: null,
    }
  }
  const detail = typeof parsed.detail === 'string' && parsed.detail.trim() ? parsed.detail.trim() : null
  const source = typeof parsed.source === 'string' ? parsed.source.trim().toUpperCase() : null
  const why = typeof parsed.why === 'string' ? parsed.why.trim() : ''

  let specific = parsed.specific
  const line = source ? sources.find((l) => l.id === source) : undefined
  if (specific) {
    // The detail has to be in the draft and share a real word with the line it cites.
    const inDraft = detail ? input.text.toLowerCase().includes(detail.toLowerCase().slice(0, 40)) : false
    const lineWords = line ? contentWords(line.text) : new Set<string>()
    const shares = detail ? [...contentWords(detail)].some((w) => lineWords.has(w)) : false
    if (!detail || !line || !inDraft || !shares) specific = false
  }
  return {
    name: 'specificity',
    verdict: specific ? 'pass' : 'fail',
    score: specific ? 1 : 0,
    threshold: SPECIFIC_THRESHOLD,
    n: 1,
    summary: specific ? `Specific: ${why}` : `Generic: ${why || 'nothing in the draft ties to the job post or company research.'}`,
    detail: specific ? detail : null,
    source: specific ? source : null,
  }
}
