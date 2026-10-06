// The search backends as LangChain tools, chained with withFallbacks (blueprint 12).
//
// Each configured backend becomes one tool. The chain is
// `first.withFallbacks(rest)`: the next tool runs only when the one before it
// throws, which is exactly the failover this module used to hand-roll. A tool
// records its own attempt in a closure, so webSearch can still say what was
// tried and why each backend failed, in priority order.
//
// The five backend functions (tavily, serper, exa, searxng, duckduckgo) stay as
// they are: they carry the freshness mapping, the quota and block detection and
// the keyless DuckDuckGo path, and their own tests. The tool is the wrapper, so
// a library tool for a backend can replace a function one at a time without the
// chain changing.

import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { SearchAttempt, SearchBackendId, SearchFailureReason, SearchResult } from './types'

export interface SearchToolCandidate {
  id: SearchBackendId
  run: () => Promise<SearchResult[]>
}

export interface SearchChainOutcome {
  /** The first tool that answered, when one did. */
  winner?: { id: SearchBackendId; results: SearchResult[] }
  /** One entry per tool that ran, success or failure. */
  attempts: Map<SearchBackendId, SearchAttempt>
}

export interface SearchChainHooks {
  classify: (error: unknown) => { reason: SearchFailureReason; detail: string }
}

/** Run `candidates` in order through withFallbacks. Resolves with every attempt
 *  made; it never throws, because "every backend failed" is an answer. */
export async function runSearchTools(candidates: SearchToolCandidate[], hooks: SearchChainHooks): Promise<SearchChainOutcome> {
  const attempts = new Map<SearchBackendId, SearchAttempt>()
  if (candidates.length === 0) return { attempts }

  const tools = candidates.map((candidate) =>
    tool(
      async () => {
        try {
          const results = await candidate.run()
          attempts.set(candidate.id, { backend: candidate.id, ok: true, reason: results.length === 0 ? 'no_results' : undefined })
          return { id: candidate.id, results }
        } catch (error) {
          const { reason, detail } = hooks.classify(error)
          attempts.set(candidate.id, { backend: candidate.id, ok: false, reason, detail })
          // Thrown on purpose: a throw is what hands the call to the next tool.
          throw error
        }
      },
      { name: `search_${candidate.id}`, description: `Search the web through ${candidate.id}.`, schema: z.object({}) }
    )
  )

  const [first, ...rest] = tools
  const chain = (rest.length > 0 ? first.withFallbacks(rest) : first) as unknown as { invoke(input: unknown): Promise<unknown> }
  try {
    const winner = (await chain.invoke({})) as { id: SearchBackendId; results: SearchResult[] }
    return { winner, attempts }
  } catch {
    return { attempts }
  }
}
