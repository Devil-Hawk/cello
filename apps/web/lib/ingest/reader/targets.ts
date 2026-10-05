// What the person is looking for, as the search words a site's own search takes,
// and the words that tell a role's title it is worth fetching at all.
//
// A site that searches gets asked for the target (never "everything"); a site
// that lists everything is filtered by these words in titles, URL slugs and
// sitemap entries BEFORE any role page is fetched.

import type { SupabaseClient } from '@supabase/supabase-js'
import { EMPTY_TARGETING, resolveTargeting, type Targeting } from '../../targeting'
import { resolveTargetTitles } from '../../targeting/titles'

export interface ReaderTargets {
  targeting: Targeting
  /** The role titles the person typed (Settings -> Targeting), most specific first. */
  titles: string[]
}

export const NO_TARGETS: ReaderTargets = { targeting: EMPTY_TARGETING, titles: [] }

/** Words that stand for a job function when the person named no titles. */
const FUNCTION_WORDS: Record<string, string> = {
  engineering: 'software engineer',
  data: 'data',
  product: 'product manager',
  design: 'designer',
  sales: 'account executive',
  marketing: 'marketing',
  support: 'customer support',
  operations: 'operations',
  finance: 'finance',
  hr: 'recruiter',
  legal: 'counsel',
}

const MAX_TERMS = 3

/** At most three search phrases: the typed titles, else one per targeted function. */
export function searchTerms(t: ReaderTargets): string[] {
  const typed = t.titles.map((x) => x.trim()).filter(Boolean)
  if (typed.length) return typed.slice(0, MAX_TERMS)
  return t.targeting.functions.map((f) => FUNCTION_WORDS[f]).filter((x): x is string => !!x).slice(0, MAX_TERMS)
}

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'at', 'ii', 'iii', 'senior', 'junior', 'staff', 'lead', 'principal'])

/** The distinct lower-case words a title or slug is matched on. */
export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !STOP.has(w)))]
}

/**
 * Could this title, or a URL slug, be a role the person wants? True with no
 * targets at all (nothing to filter on). Matching is on whole words, so "data"
 * matches "Data Engineer" and "data-engineer" but not "Metadata Librarian".
 * "Engineer" is shared by many words, so a phrase counts when all of its
 * distinguishing words appear; the function words only add "engineer".
 */
export function matchesTargets(titleOrSlug: string, t: ReaderTargets): boolean {
  const terms = searchTerms(t)
  if (terms.length === 0) return true
  const have = new Set(wordsOf(titleOrSlug))
  const extra = t.targeting.functions.includes('engineering') ? ['engineer', 'engineering', 'developer', 'sre'] : []
  const dataExtra = t.targeting.functions.includes('data') ? ['data', 'analytics', 'analyst', 'scientist', 'ml', 'machine'] : []
  for (const term of terms) {
    const words = wordsOf(term)
    if (words.length && words.every((w) => have.has(w))) return true
  }
  return [...extra, ...dataExtra].some((w) => have.has(w))
}

type Db = SupabaseClient<any, any, any>

/** The person's targets, from profiles.preferences. */
export async function loadTargets(client: Db, userId: string): Promise<ReaderTargets> {
  try {
    const { data } = await client.from('profiles').select('preferences').eq('id', userId).maybeSingle()
    const preferences = (data as { preferences?: unknown } | null)?.preferences
    return { targeting: resolveTargeting(preferences), titles: resolveTargetTitles(preferences) }
  } catch {
    return NO_TARGETS
  }
}
