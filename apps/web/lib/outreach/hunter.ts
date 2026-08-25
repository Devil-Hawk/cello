// Optional BYO-key contact enrichment via Hunter.io (https://hunter.io).
//
// Strictly opt-in: only runs when the user has stored a Hunter key at
// profiles.preferences.api_keys.hunter. Absent key => the feature is silently
// off (findContacts returns []). Framework-free (global fetch) so it runs in the
// harness/cron context too. NOT LinkedIn / third-party network harvesting — this
// is a domain-scoped professional email lookup the user explicitly enabled.

export interface EnrichedContact {
  name: string | null
  email: string
  title: string | null
  confidence: number
}

interface HunterEmail {
  value: string
  first_name?: string | null
  last_name?: string | null
  position?: string | null
  confidence?: number | null
  type?: string | null
}

/**
 * Find likely contacts at a company domain via Hunter's domain-search API.
 * Returns [] when no key is provided or the request fails (never throws).
 */
export async function findContacts(
  domain: string,
  hunterKey: string | undefined,
  opts: { limit?: number; signal?: AbortSignal } = {}
): Promise<EnrichedContact[]> {
  if (!hunterKey) return []
  const clean = domain.toLowerCase().replace(/^www\./, '').trim()
  if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) return []

  const limit = Math.min(25, Math.max(1, opts.limit ?? 10))
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(clean)}&limit=${limit}&api_key=${encodeURIComponent(hunterKey)}`

  try {
    const res = await fetch(url, { signal: opts.signal })
    if (!res.ok) return []
    const json = (await res.json()) as { data?: { emails?: HunterEmail[] } }
    const emails = json.data?.emails || []
    return emails
      .filter((e) => typeof e.value === 'string' && e.value.includes('@'))
      .map((e) => {
        const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim()
        return {
          name: name || null,
          email: e.value.toLowerCase(),
          title: e.position || null,
          confidence: typeof e.confidence === 'number' ? e.confidence / 100 : 0.5,
        }
      })
  } catch {
    return []
  }
}
