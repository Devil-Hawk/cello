// What the specialists share: how a brief arrives, how a result leaves, and the one
// place a compiled specialist graph is invoked.
//
// A specialist is reached two ways. The orchestrator delegates with the task
// tool, which hands the graph a message whose text is the brief. A tool such as
// create_artifact runs the same graph inline with the brief already structured.
// Both end the same way: a short JSON summary of about 1,500 tokens or less plus
// artifact ids. The full work lives in the artifacts table, and the orchestrator
// treats the summary as data.

import type { z } from 'zod'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'

export interface BriefParse<T> {
  ok: boolean
  brief?: T
  /** What to tell the caller when the brief was not usable. */
  error?: string
}

/** The text of the last human message, which is the brief when a specialist is reached through task. */
export function lastHumanText(messages: readonly BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (HumanMessage.isInstance(m) || (m as { type?: string }).type === 'human') {
      return typeof m.content === 'string' ? m.content : m.content.map((b) => (b as { text?: string }).text ?? '').join('')
    }
  }
  return ''
}

/** Pull one JSON object out of a delegation description (bare, or inside a code fence). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function parseBrief<T>(schema: z.ZodType<T>, text: string, shape: string): BriefParse<T> {
  const raw = extractJson(text)
  if (raw === undefined) return { ok: false, error: `The brief must be a JSON object like ${shape}.` }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: `The brief is not usable (${first?.path.join('.') || 'brief'}: ${first?.message}). Expected ${shape}.` }
  }
  return { ok: true, brief: parsed.data }
}

/** The result every specialist hands back: JSON the orchestrator reads as data. */
export function summaryMessage(summary: Record<string, unknown>): AIMessage {
  return new AIMessage(JSON.stringify(summary))
}

/**
 * The one place a compiled specialist graph is invoked. The scan in
 * chokepoints.test.ts allows `.invoke(` here, in run.ts and in fanout.ts only.
 */
export async function invokeSpecialist<TIn, TOut>(
  graph: { invoke: (input: TIn, config?: RunnableConfig) => Promise<TOut> },
  input: TIn,
  config?: RunnableConfig
): Promise<TOut> {
  return graph.invoke(input, { recursionLimit: 40, ...config })
}

/**
 * A line of live activity for the person ("Checking the draft against your resume").
 * It goes out as a custom stream event; when nothing is listening it does nothing.
 */
export function activity(config: RunnableConfig | undefined, text: string): void {
  const writer = (config as { writer?: (chunk: unknown) => void } | undefined)?.writer
  try {
    writer?.({ kind: 'activity', text })
  } catch {
    // A closed stream must not stop the work.
  }
}

/** A tool-style failure the model can act on. */
export interface Fix {
  error: string
  fix: string
}

export const isFix = (v: unknown): v is Fix => typeof v === 'object' && v !== null && 'error' in v && 'fix' in v
