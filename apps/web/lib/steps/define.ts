// defineModelStep: every model call, declared (blueprint 5.2, directive 20).
//
// A step names the measure that judges it, the lowest rung at which it still does
// its job and what happens below that. Calling it runs callLlm under the step's
// id, so the spend ledger and Langfuse show what the call was for, and returns
// where the value came from: the step, the model, the rung it ran on and what it
// rested on. lib/steps/source.test.ts fails on a raw model call outside the
// steps, so no value reaches a stored row without that record.
//
// A step with no `prompt` moves a call over unchanged: its caller's own system
// text goes through byte for byte. A step with a `prompt` gets the central policy
// (./policy.ts) ahead of it.

import type { z } from 'zod'
import { callLlm } from '../harness/llm'
import { rungFor } from '../harness/spend'
import { resolveProviderId } from '../harness/providers'
import type { DecryptedApiKeys, Door, LlmResult, LlmRunner, LlmRunOptions } from '../harness/types'
import { isMeasureId } from '../commands/measures'
import type { Rung } from '../models/doors.types'
import type { Evidence, Prov } from '../provenance/types'
import { withPolicy } from './policy'

export type StepKind = 'step' | 'loop' | 'embed'

export interface ModelStepDef {
  /** The name the ledger and Langfuse show. A declared 5.2 id, or for a call not
   *  yet mapped to one, the name it has always had. */
  id: string
  kind: StepKind
  /** A measure id from the register (13.1). */
  measure: string
  /** The lowest rung at which the step still does its job (blueprint 11.2). */
  minRung: Rung
  /** What the person gets when no rung at or above minRung is available. */
  below: string
  /** The step's own instruction. Declaring one adds the central policy. */
  prompt?: string
  /** The shape the reply must have, when it is JSON. */
  outputSchema?: z.ZodType
  /** A code check on the reply text: a sentence naming the problem, or null. */
  check?: (content: string) => string | null
  /** A call not yet mapped to one of the declared ids; the package that retires it. */
  legacy?: { retiredBy: string }
}

export interface StepCallContext {
  door?: Door
  signal?: AbortSignal
  /** What the value rests on, written into prov. */
  evidence?: Evidence[]
}

export type StepResult = LlmResult & { prov: Prov; parsed?: unknown }

export interface ModelStep {
  id: string
  meta: ModelStepDef
  call(keys: DecryptedApiKeys, opts: LlmRunOptions, ctx?: StepCallContext): Promise<StepResult>
  /** For callers that take an LlmRunner: every call goes through the step. */
  runner(keys: DecryptedApiKeys, ctx?: StepCallContext): LlmRunner
}

export class StepOutputError extends Error {
  constructor(
    readonly step: string,
    message: string
  ) {
    super(`${step}: ${message}`)
    this.name = 'StepOutputError'
  }
}

/** Checks a definition and returns it. Shared by every kind of step. */
export function declareStep(def: ModelStepDef): ModelStepDef {
  if (!def.id.trim()) throw new Error('A model step needs an id')
  if (!isMeasureId(def.measure)) throw new Error(`Model step ${def.id} must name its measure from the register, not "${def.measure}"`)
  if (!def.below.trim()) throw new Error(`Model step ${def.id} must say what happens below its lowest rung`)
  if (def.legacy && !def.legacy.retiredBy.trim()) throw new Error(`Model step ${def.id} is legacy and must name the package that retires it`)
  return def
}

/** A model reply that is JSON, possibly inside a fence or after some prose. */
function parseJson(content: string): unknown {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const match = trimmed.match(/[[{][\s\S]*[\]}]/)
    if (!match) throw new Error('the reply was not valid JSON')
    return JSON.parse(match[0])
  }
}

export function defineModelStep(input: ModelStepDef): ModelStep {
  const def = declareStep(input)

  const call: ModelStep['call'] = async (keys, opts, ctx = {}) => {
    const runOpts: LlmRunOptions = {
      ...opts,
      ...(def.prompt ? { system: withPolicy(def.prompt, opts.system) } : {}),
      door: ctx.door ?? opts.door,
    }
    // The step id is the generation name in the ledger and in Langfuse.
    const result = await callLlm(keys, { ...runOpts, name: def.id }, ctx.signal)

    let parsed: unknown
    if (def.outputSchema) {
      try {
        parsed = def.outputSchema.parse(parseJson(result.content))
      } catch (e) {
        throw new StepOutputError(def.id, e instanceof Error ? e.message : 'the reply did not match its shape')
      }
    }
    const problem = def.check?.(result.content)
    if (problem) throw new StepOutputError(def.id, problem)

    const prov: Prov = {
      step: def.id,
      model: result.model,
      rung: rungFor(resolveProviderId(keys.provider?.active), result.model),
      evidence: ctx.evidence ?? [],
      at: new Date().toISOString(),
    }
    return { ...result, prov, ...(def.outputSchema ? { parsed } : {}) }
  }

  return {
    id: def.id,
    meta: def,
    call,
    runner: (keys, ctx) => (opts) => call(keys, opts, ctx),
  }
}
