// The server's own embedder: Xenova/all-MiniLM-L6-v2 on Transformers.js, 384
// dimensions, no key and no cost to the person (blueprint 11.1 rung R0s). mem0's
// `learnings` collection, the learner and role typing share it, so learning works
// for a person who has no model at all.
//
// The no-embedder state is a normal answer, not an error: embed384 returns null
// when the library or the model files cannot be loaded (spike SP3 failed, no
// network on a cold start). Callers keep going on words.

export const EMBED384_DIMS = 384
export const EMBED384_MODEL = 'Xenova/all-MiniLM-L6-v2'

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>

let loading: Promise<Extractor | null> | undefined

async function load(): Promise<Extractor | null> {
  try {
    const hf = await import('@huggingface/transformers')
    // Vercel's only writable path. A cold function downloads the 23 MB model once.
    hf.env.cacheDir = '/tmp/transformers-cache'
    hf.env.allowLocalModels = false
    const make = hf.pipeline as unknown as (task: string, model: string, opts: { dtype: string }) => Promise<Extractor>
    return await make('feature-extraction', EMBED384_MODEL, { dtype: 'q8' })
  } catch (err) {
    console.error('lib/memory/embedder: no embedder, carrying on without one:', err instanceof Error ? err.message : err)
    return null
  }
}

/** One 384-dimension unit vector per text, or null when there is no embedder. */
export async function embed384(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  // ponytail: a failed load is cached for the life of the process; a redeploy retries.
  loading ??= load()
  const extractor = await loading
  if (!extractor) return null
  try {
    return (await extractor(texts, { pooling: 'mean', normalize: true })).tolist()
  } catch {
    return null
  }
}
