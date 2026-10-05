// The Researcher: the only specialist that loops on its own.
//
// It is a Deep Agents SubAgent, not a fixed graph, because what to read next depends
// on what the last page said. It is bounded by code: eight model calls, read-only file
// access, and only read tools. It reads text anyone could have written, so it has no
// tool that sends, submits or saves, and it hands back only a cited summary.
//
// This file holds what is specific to the Researcher: its brief, its result, and how
// the result is read from its last message. The spec itself is assembled in
// factory.ts, because every agent is built there with the guards attached.

import { extractJson } from './common'

export const RESEARCHER_DESCRIPTION =
  'Researches one company, person or topic on the open web and the person\'s saved notes, in at most eight steps. Reads trusted sources first and cites every claim with a url it read. ' +
  'Says there is not enough public information when fewer than two independent sources agree. Read only: it never saves, sends or submits. ' +
  'Pass the description as a JSON brief like {"subject":"Stripe","kind":"company"}. Returns a short JSON summary with sources.'

export interface ResearcherSource {
  title?: string | null
  url: string
}

export interface ResearcherResult {
  /** At most about 250 words, every claim tied to a source. Empty when there was not enough to say. */
  summary: string
  sources: ResearcherSource[]
  /** False when the public sources were too thin to say anything reliable. */
  enough_information: boolean
  /** The loop ran out of steps before it finished. What it has is still reported. */
  hit_step_limit: boolean
}

export function researcherBrief(subject: string, kind: 'company' | 'person' | 'topic'): string {
  return JSON.stringify({ subject, kind })
}

const URL_RE = /^https?:\/\//i

/** Read the Researcher's final message. A reply that is not the expected JSON counts as not enough information, never as a guess. */
export function parseResearcherResult(text: string, hitStepLimit = false): ResearcherResult {
  const raw = extractJson(text) as { summary?: unknown; sources?: unknown; enough_information?: unknown } | undefined
  const sources: ResearcherSource[] = Array.isArray(raw?.sources)
    ? (raw!.sources as unknown[])
        .map((s) => s as { url?: unknown; title?: unknown })
        .filter((s): s is { url: string; title?: string } => typeof s?.url === 'string' && URL_RE.test(s.url))
        .map((s) => ({ url: s.url, title: typeof s.title === 'string' ? s.title : null }))
        .slice(0, 20)
    : []
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim() : ''
  const claimed = raw?.enough_information === true
  // A summary with no source is not a researched answer.
  const enough = claimed && summary.length > 0 && sources.length > 0
  return { summary: enough ? summary : '', sources, enough_information: enough, hit_step_limit: hitStepLimit }
}
