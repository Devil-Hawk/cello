// The free hosted models (rung R3). The variable and the default list match the
// engine's lib/agents/model.ts, so Chat points its file here when it moves to the
// factory (K24a) and the two lists never drift.

export const DEFAULT_FREE_MODELS = [
  'qwen/qwen3.8-27b:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
] as const

export const isFreeModel = (id: string): boolean => id.endsWith(':free')

/**
 * The free list, from AGENT_FREE_MODELS (comma separated) or the default. An id
 * that does not end in ":free" is dropped: a free pick must never be able to
 * spend money the cap did not reserve.
 */
export function freeModels(env: string | undefined = process.env.AGENT_FREE_MODELS): string[] {
  const listed = (env ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const free = (listed.length > 0 ? listed : [...DEFAULT_FREE_MODELS]).filter(isFreeModel)
  return free.length > 0 ? free : [...DEFAULT_FREE_MODELS]
}
