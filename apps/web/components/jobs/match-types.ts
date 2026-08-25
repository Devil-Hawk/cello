// Shared match-score types/helpers — split out of match-badge.tsx so it and
// match-score-breakdown.tsx can both depend on this without an import cycle
// (match-badge renders <MatchScoreBreakdown> in its tooltip; the breakdown
// needs these same types).

/** Superset of the shapes /api/agents/match and older rows store in jobs.match_details. */
export interface MatchDetails {
  overallScore?: number
  highlights?: string[]
  gaps?: string[]
  skillsMatch?: number
  experienceMatch?: number
  educationMatch?: number
  /** 0-100 — see lib/harness/agents/matcher.ts's LlmVerdict.locationMatch. */
  locationMatch?: number
  /** One short phrase, e.g. "Strong fit for senior IC" — matcher.ts's seniorityFit. */
  seniorityFit?: string
  /** 2-3 sentence plain-language verdict explanation — matcher.ts's summary. */
  summary?: string
  skills?: { matched: string[]; missing: string[] }
  experience?: { level: string; match: boolean }
  location?: { match: boolean; note?: string }
}

export function parseMatchDetails(
  details: MatchDetails | string | null | undefined
): MatchDetails | null {
  if (!details) return null
  if (typeof details === 'string') {
    try {
      return JSON.parse(details)
    } catch {
      return null
    }
  }
  return details
}

/** The three named sub-dimensions matcher.ts's LlmVerdict scores — present only
 *  for jobs scored via the single-job path (not the lighter batch scorer). */
export interface MatchSubScore {
  key: 'skillsMatch' | 'experienceMatch' | 'locationMatch'
  label: string
  value: number
}

/** Career-ops-style rubric: every sub-score named, not just an overall number. */
export function subScoresFor(details: MatchDetails | null | undefined): MatchSubScore[] {
  if (!details) return []
  const out: MatchSubScore[] = []
  if (typeof details.skillsMatch === 'number') out.push({ key: 'skillsMatch', label: 'Skills', value: details.skillsMatch })
  if (typeof details.experienceMatch === 'number') out.push({ key: 'experienceMatch', label: 'Experience', value: details.experienceMatch })
  if (typeof details.locationMatch === 'number') out.push({ key: 'locationMatch', label: 'Location', value: details.locationMatch })
  return out
}
