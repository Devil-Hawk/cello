// The tier a measure's run was made on, written into the run's note so no column is needed.
//   local = R2 (this computer), free = R3 (free hosted models), paid = R4. The free tier is the headline number.
// Note: `tier=free model=<id>[,<id>] core=deep prompt_tokens=1834; <rest>`. A note without a tier is a legacy run.

export const TIERS = ['local', 'free', 'paid'] as const
export type Tier = (typeof TIERS)[number]

export interface RunMeta {
  tier: Tier
  /** One model id, or several joined with ',' and no spaces. */
  model: string
  core: 'deep' | 'plain'
  promptTokens?: number | null
}

export function runNote(meta: RunMeta, rest?: string): string {
  const head = `tier=${meta.tier} model=${meta.model} core=${meta.core}${meta.promptTokens == null ? '' : ` prompt_tokens=${meta.promptTokens}`}`
  return rest ? `${head}; ${rest}` : head
}

export interface ParsedNote {
  tier: Tier | null
  model: string | null
  core: 'deep' | 'plain' | null
  promptTokens: number | null
}

/** Tolerant: anything after the first '; ' is ignored, and a note with no tier gives nulls. */
export function parseRunNote(note: string | null): ParsedNote {
  const head = (note ?? '').split('; ')[0]
  const pick = (key: string) => head.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))?.[1] ?? null
  const tier = pick('tier')
  const core = pick('core')
  const tokens = pick('prompt_tokens')
  return {
    tier: (TIERS as readonly string[]).includes(tier ?? '') ? (tier as Tier) : null,
    model: pick('model'),
    core: core === 'deep' || core === 'plain' ? core : null,
    promptTokens: tokens !== null && /^\d+$/.test(tokens) ? Number(tokens) : null,
  }
}
