// The one place material is embedded. Material search uses 384 dimension vectors (the
// server embedder, MiniLM, lib/memory/embedder.ts): it holds no key and costs the person
// nothing. The person's own provider only makes 1536 dimension vectors, which
// search_material cannot use, so no provider is called here.
//
// With no embedder (the library or its model files cannot load) every text comes back
// null and search is words only.

import { embed384 } from '../memory/embedder'
import type { DecryptedApiKeys } from '../harness/types'

export const EMBED_DIM = 384

/** True when the server embedder is part of the build. The owner-run scripts read it. */
export const EMBEDDER_READY = true as boolean

/** Embed texts for material search. A text with no 384 vector comes back null. */
export async function embedMaterial(
  _keys: DecryptedApiKeys,
  texts: string[],
  _name: string,
  _signal?: AbortSignal
): Promise<Array<number[] | null>> {
  const vectors = await embed384(texts)
  return texts.map((_, i) => vectors?.[i] ?? null)
}
