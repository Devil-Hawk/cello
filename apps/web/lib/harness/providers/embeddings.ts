// Embedding provider plumbing — the backends lib/harness/llm.ts#callEmbedding
// falls through, plus a deterministic test-only embedder. Split out of llm.ts
// the same way ./openrouter and ./local-server are split out of callLlm: one
// HTTP-shaped backend per file, llm.ts stays the orchestration + chokepoint
// (budget guard, spend recording, fallback order).
//
// EMBEDDING MODEL IS LOCKED (2026-08-16 langgraph port spec, ruling 10):
// openai/text-embedding-3-small, 1536 dims. OpenRouter and OpenAI-direct serve
// IDENTICAL vectors for this model, so falling back between them never forces
// a re-embed of anything already stored. Every response is dimension-checked
// before it's handed back — a provider silently serving a different model
// would otherwise poison the ANN space with incompatible vectors (the exact
// failure mode the mem0 doctrine calls out by name).

import { OpenAIEmbeddings } from '@langchain/openai'
import type { DecryptedApiKeys } from '../types'
import { MissingKeyError, ProviderUnavailableError, estimateTokens, isSelfHosted } from './index'

/** OpenRouter's catalog id (vendor-prefixed) — also the PRICES key in spend.ts. */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMS = 1536

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export interface EmbedBatchResult {
  embeddings: number[][]
  model: string
  promptTokens: number
  /** Provider-reported cost, USD, when the response carries one. */
  costUsd?: number
}

/** Strip a trailing slash, same normalization local-server.ts uses for chat. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Never let a wrong-width vector reach a pgvector(1536) column. */
function assertDims(embeddings: number[][], source: string): void {
  for (const vec of embeddings) {
    if (vec.length !== EMBEDDING_DIMS) {
      throw new Error(
        `${source} returned a ${vec.length}-dim embedding, expected ${EMBEDDING_DIMS} — refusing it rather ` +
          `than writing a vector into the ANN space that isn't comparable to the rest.`
      )
    }
  }
}

/** One OpenAI-compatible embeddings endpoint, through LangChain's OpenAIEmbeddings. Newlines are
 *  kept: the texts are résumés and notes, and stripping them would change what is embedded. */
function embedder(model: string, apiKey: string, baseURL: string): OpenAIEmbeddings {
  return new OpenAIEmbeddings({ model, apiKey, stripNewLines: false, maxRetries: 0, configuration: { baseURL } })
}

async function requestEmbeddings(
  client: OpenAIEmbeddings,
  model: string,
  texts: string[],
  _signal: AbortSignal | undefined,
  source: string
): Promise<EmbedBatchResult> {
  // Vectors come back in input order. The class returns no usage and takes no abort signal
  // (ponytail: so tokens are estimated, no provider cost is read and the price table applies,
  // and a cancel waits for the request; both go when K15's server embedder replaces this).
  const embeddings = await client.embedDocuments(texts)
  assertDims(embeddings, source)
  return { embeddings, model, promptTokens: estimateTokens(texts.join('\n')) }
}

/** Primary: OpenRouter's embeddings endpoint, same key as chat completions. */
export async function callOpenRouterEmbedding(
  apiKeys: DecryptedApiKeys,
  texts: string[],
  model: string = EMBEDDING_MODEL,
  signal?: AbortSignal
): Promise<EmbedBatchResult> {
  const key = apiKeys.openrouter
  if (!key) throw new MissingKeyError('No OpenRouter API key configured')
  return requestEmbeddings(embedder(model, key, OPENROUTER_BASE_URL), model, texts, signal, 'OpenRouter')
}

/**
 * Fallback 1: OpenAI direct. Same locked model, identical vectors — OpenAI's
 * own API takes the bare id (no vendor prefix), so an OpenRouter-shaped id is
 * translated; a caller-supplied override that's already bare passes through.
 */
export async function callOpenAiDirectEmbedding(
  apiKeys: DecryptedApiKeys,
  texts: string[],
  model: string = EMBEDDING_MODEL,
  signal?: AbortSignal
): Promise<EmbedBatchResult> {
  const key = apiKeys.openai
  if (!key) throw new MissingKeyError('No OpenAI API key configured')
  const directModel = model.startsWith('openai/') ? model.slice('openai/'.length) : model
  return requestEmbeddings(embedder(directModel, key, OPENAI_BASE_URL), directModel, texts, signal, 'OpenAI-direct')
}

/**
 * Fallback 2: the user's own OpenAI-compatible local server — ONLY when
 * they've configured an embedding model there
 * (provider.localServerEmbeddingModel). We can't inspect a model's dims
 * before calling it, so the "it's 1536-dim" claim is the user's; assertDims()
 * inside requestEmbeddings() is what actually enforces ruling 10 rather than
 * trusting the configured id.
 */
export async function callLocalServerEmbedding(
  apiKeys: DecryptedApiKeys,
  texts: string[],
  signal?: AbortSignal
): Promise<EmbedBatchResult> {
  const model = apiKeys.provider?.localServerEmbeddingModel?.trim()
  if (!model) throw new MissingKeyError('No local-server embedding model configured')
  if (!isSelfHosted()) {
    throw new ProviderUnavailableError(
      'Local server providers only work when Cello is self-hosted — this instance is running on Vercel serverless.'
    )
  }
  const baseUrl = apiKeys.provider?.localServerBaseUrl?.trim()
  if (!baseUrl) {
    throw new ProviderUnavailableError(
      'No local server URL configured — set one (e.g. http://localhost:11434/v1 for Ollama) in Settings → Model.'
    )
  }
  try {
    return await requestEmbeddings(embedder(model, 'local-server-no-key-required', normalizeBaseUrl(baseUrl)), model, texts, signal, 'local server')
  } catch (err) {
    // A dimension mismatch is real signal, not unreachability — surface it
    // verbatim rather than relabeling it as "did not respond".
    if (err instanceof Error && err.message.includes('refusing it')) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ProviderUnavailableError(`Local server at ${baseUrl} did not respond: ${message}`)
  }
}

/**
 * Deterministic seeded embedder — TEST-ONLY. Never touches the network, never
 * costs money, always returns the same 1536-dim vector for the same text and
 * a different one for different text. Mem0 doctrine (2026-08-16 langgraph
 * port spec) is explicit: "a deterministic test embedder exists ONLY behind a
 * test-env guard" — production ANN space must never see a hash/test vector
 * sitting next to a real one. Guarded on process.env.VITEST, which vitest
 * sets on every test worker and is set nowhere else in this repo (see
 * vitest.config.ts — no override of it exists).
 */
export function testEmbedding(text: string, dims: number = EMBEDDING_DIMS): number[] {
  if (!process.env.VITEST) {
    throw new Error('testEmbedding() is test-only — called outside a vitest run')
  }
  // mulberry32, seeded from a rolling hash of the text. Same text -> same
  // seed -> same vector; different text reliably diverges. Not remotely a
  // semantic embedding — ponytail: if a test ever needs real semantic
  // similarity, that test needs a real provider call, not a bigger version of
  // this function.
  let seed = 0
  for (let i = 0; i < text.length; i++) {
    seed = (Math.imul(seed, 31) + text.charCodeAt(i)) >>> 0
  }
  if (seed === 0) seed = 1
  const vec = new Array<number>(dims)
  for (let i = 0; i < dims; i++) {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    vec[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5
  }
  return vec
}
