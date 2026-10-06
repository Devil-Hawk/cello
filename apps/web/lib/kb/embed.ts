// lane-stub: K15 embedStep
//
// The one place material is embedded. Material search uses 384 dimension vectors (the
// server embedder, MiniLM), which K15's `embed` step provides. Until K15 is on main there
// is no 384 embedder, and the person's own provider only makes 1536 dimension vectors,
// which search_material cannot use. So this calls no provider and spends nothing: every
// text comes back null and search is words only. When K15 lands, this file becomes one
// call to embedStep, EMBEDDER_READY goes, and the stub marker goes with them.

import type { DecryptedApiKeys } from '../harness/types'

export const EMBED_DIM = 384

/** False until K15 is on main. The owner-run scripts read it to say they embed nothing. */
export const EMBEDDER_READY = false as boolean

/** Embed texts for material search. A text with no 384 vector comes back null. */
export async function embedMaterial(
  _keys: DecryptedApiKeys,
  texts: string[],
  _name: string,
  _signal?: AbortSignal
): Promise<Array<number[] | null>> {
  return texts.map(() => null)
}
