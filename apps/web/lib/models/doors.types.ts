// The door a model call goes through (blueprint 11.1, 5.2). Types only, pushed
// first so the lanes that build against the ladder have a shape to import.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DecryptedApiKeys, Door, LlmResult, LlmRunOptions } from '../harness/types'
import type { Prov } from '../provenance/types'

export type { Door }

/** R0 code, R0s Cello's server embedder, R1 this browser, R2 this computer,
 *  R3 free hosted models, R4 the person's own key. */
export type Rung = 'R0' | 'R0s' | 'R1' | 'R2' | 'R3' | 'R4'

/** "Highest Cello may use". R0s is not a ceiling: it is a free embedder step. */
export type Ceiling = 'R0' | 'R1' | 'R2' | 'R3' | 'R4'

/** A declared model step as the ladder sees it. */
export interface StepRef {
  id: string
  /** The lowest rung at which the step still does its job. */
  minRung: Rung
  /** What the person gets when no rung at or above minRung can run. */
  below: string
}

export interface PersonModels {
  ceiling: Ceiling
  /** The person's preferred order, most preferred first. */
  order: Rung[]
  /** True once an OpenRouter key has had credit bought on it. */
  creditBought: boolean
}

export type RungVia = 'openrouter' | 'openai' | 'anthropic' | 'local-server' | 'local-cli' | 'relay'

export type RungPick =
  | { rung: Rung; model: string; via: RungVia }
  | { rung: null; reason: 'below_min' | 'none_available'; sentence: string }

export interface ModelDoorContext {
  door: Door
  userId?: string
  signal?: AbortSignal
}

export interface ModelDoor {
  pickRung(step: StepRef, person: PersonModels, available: Rung[], keys: DecryptedApiKeys): RungPick
  complete(step: StepRef, opts: LlmRunOptions, ctx: ModelDoorContext): Promise<LlmResult & { prov: Prov }>
  chatModel(step: StepRef, ctx: ModelDoorContext): Promise<BaseChatModel>
}
