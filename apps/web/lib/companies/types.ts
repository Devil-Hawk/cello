// Client-safe types for "Suggested for you". Type-only imports, no server code: the Companies screen imports these.

import type { AtsProviderId } from '../ats/types'

export type AtsProviderName = AtsProviderId

export const DISMISS_REASONS = ['not_my_field', 'location', 'company_size', 'know_them', 'other'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]

export interface SuggestionSignal {
  kind: 'board' | 'posting' | 'thread' | 'similar'
  url: string
  label: string
  title?: string
  /** Where the role or office is, as the source states it. */
  location?: string | null
  postedAt?: string | null
  count?: number
  liked?: string
  tags?: string[]
}

export type SuggestionTier = 1 | 2 | 3 | 4

export interface Suggestion {
  id: string
  name: string
  domain: string | null
  logoUrl: string | null
  tier: SuggestionTier
  rank: number
  reason: string
  sourceUrl: string
  sourceLabel: string
  signals: SuggestionSignal[]
  ats: { provider: AtsProviderName; openRoles: number; matchingRoles: number } | null
  status: 'open' | 'added' | 'dismissed'
}

export interface SuggestionsResponse {
  status: 'ready' | 'not_built' | 'needs_targeting'
  refresh: {
    state: 'ok' | 'partial' | 'failed' | null
    computedAt: string | null
    nextRefreshAt: string | null
  }
  suggestions: Suggestion[]
}

/** A company the ranking can compare against: a Y Combinator candidate with its tags, or a verified employer's name and domain. */
export interface YcRow {
  name: string
  name_key: string
  domain: string | null
  source: 'yc' | 'directory'
  profile_url: string | null
  tags: string[]
  regions: string[]
  locations: string | null
}

export interface BoardJob {
  title: string
  location: string | null
  url: string
  postedAt: string | null
}

/** What a live read of a verified board saw, held in memory for matching. */
export interface BoardHit {
  provider: AtsProviderName
  token: string
  boardUrl: string
  openRoles: number
  /** Up to 200 jobs with location and link. */
  jobs: BoardJob[]
}
