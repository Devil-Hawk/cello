// The embed step: every embedding goes through here (blueprint 5.2, 11.1).
// Embedding is a model step like any other: it names its measure, it runs through
// callEmbedding's spend chokepoint, and it says where the vectors came from.
//
// Below its rung (no embedder at all) the product falls back to words: words-only
// search and recall, reactions saved but not ordering, role typing without tier 2.

import { callEmbedding, type EmbedResult } from '../harness/llm'
import type { DecryptedApiKeys, Door } from '../harness/types'
import type { Prov } from '../provenance/types'
import { declareStep, type ModelStepDef } from './define'

const meta: ModelStepDef = declareStep({
  id: 'embed',
  kind: 'embed',
  measure: 'S12',
  minRung: 'R0s',
  below: 'Search uses words only, and what Cello learns is saved but does not order results yet.',
})

export interface EmbedOptions {
  texts: string[]
  model?: string
  /** What these vectors are for, for the ledger: embed-chunks, embed-query. */
  name?: string
}

export interface EmbedStepResult extends EmbedResult {
  prov: Prov
}

export const embedStep = {
  id: meta.id,
  meta,
  async call(keys: DecryptedApiKeys, opts: EmbedOptions, ctx: { door?: Door; signal?: AbortSignal } = {}): Promise<EmbedStepResult> {
    const result = await callEmbedding(keys, { texts: opts.texts, model: opts.model, name: opts.name ?? meta.id }, ctx.signal)
    // callEmbedding tries OpenRouter, then OpenAI, then a local server, in that order.
    const rung = keys.openrouter || keys.openai ? 'R4' : 'R2'
    return {
      ...result,
      prov: { step: meta.id, model: result.model, rung, evidence: [], at: new Date().toISOString() },
    }
  },
}
