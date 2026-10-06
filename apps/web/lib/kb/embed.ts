// lane-stub: K15 embedStep
//
// The one place material is embedded. Material search uses 384 dimension vectors (the
// server embedder, MiniLM). K15 turns the `embed` step into that embedder; until it
// is on main this calls the person's own embedding provider, and a vector that is not
// 384 long is dropped, so search stays words only rather than mixing scales. When
// K15 lands, this file becomes one call to embedStep and the stub marker goes.

import { callEmbedding } from '../harness/llm'
import type { DecryptedApiKeys } from '../harness/types'

export const EMBED_DIM = 384

/** Embed texts for material search. A text with no usable 384 vector comes back null. Throws as callEmbedding does (no provider, cap). */
export async function embedMaterial(
  keys: DecryptedApiKeys,
  texts: string[],
  name: string,
  signal?: AbortSignal
): Promise<Array<number[] | null>> {
  const { embeddings } = await callEmbedding(keys, { texts, name }, signal)
  return texts.map((_, i) => (embeddings[i]?.length === EMBED_DIM ? (embeddings[i] as number[]) : null))
}
