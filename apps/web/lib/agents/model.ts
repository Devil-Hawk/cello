// The one door for agent model calls.
//
// Every agent loop (the orchestrator and the Researcher) talks to a model
// through celloChatModel(), which wraps LangChain's ChatOpenRouter. This is the
// only file allowed to say `new ChatOpenRouter(` (lib/agents/chokepoints.test.ts
// scans for it). Calls that are not agent loops (the specialist workflows, every
// button that needs one completion) go through callLlm, which shares the same
// spend and demo core. Two doors, one for each kind of call.
//
// The key is the user's OpenRouter key. ChatOpenRouter cannot drive a local CLI
// or a local server, so a user on those gets MissingKeyError here and the stream
// route tells them to add a key; their non-agent features keep working.

import { ChatOpenRouter } from '@langchain/openrouter'
import { MissingKeyError } from '@/lib/harness/providers'
import { openRouterUserTag } from '@/lib/harness/providers/openrouter'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { resolveModelId } from '@/lib/models'

export type ModelPurpose = 'orchestrator' | 'researcher' | 'eval'

/** Output budget per turn. The orchestrator writes answers; the Researcher writes a short cited summary. */
const MAX_TOKENS: Record<ModelPurpose, number> = {
  orchestrator: 4096,
  researcher: 2048,
  eval: 1024,
}

/** Free models used when the primary cannot be reserved or is rate limited. */
export const DEFAULT_FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
] as const

export const isFreeModel = (id: string): boolean => id.endsWith(':free')

/**
 * The fallback list, from AGENT_FREE_MODELS (comma separated) or the default.
 * An id that does not end in ":free" is dropped: a fallback must never be able
 * to spend money the cap did not reserve.
 */
export function freeFallbackModels(env: string | undefined = process.env.AGENT_FREE_MODELS): string[] {
  const listed = (env ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const source = listed.length > 0 ? listed : [...DEFAULT_FREE_MODELS]
  return source.filter(isFreeModel)
}

export interface CelloChatModelOptions {
  apiKeys: DecryptedApiKeys
  /** Overrides the user's chosen model (used for fallbacks and evals). */
  model?: string
  purpose: ModelPurpose
  /** Lets OpenRouter itself fall through the free list when a provider errors. Off for demos. */
  serverFallback?: boolean
}

export function celloChatModel(opts: CelloChatModelOptions): ChatOpenRouter {
  const key = opts.apiKeys.openrouter?.trim()
  if (!key) throw new MissingKeyError('No OpenRouter API key configured')
  const model = opts.model ?? resolveModelId(opts.apiKeys.model)
  const free = freeFallbackModels()
  return new ChatOpenRouter({
    model,
    apiKey: key,
    temperature: 0.2,
    maxTokens: MAX_TOKENS[opts.purpose],
    siteUrl: 'https://cello.app',
    siteName: 'Cello',
    ...(opts.apiKeys.userId ? { user: openRouterUserTag(opts.apiKeys.userId) } : {}),
    // Only free ids, so a server-side fallback can never add spend.
    ...(opts.serverFallback && !isFreeModel(model) && free.length > 0 ? { models: free, route: 'fallback' as const } : {}),
  })
}
