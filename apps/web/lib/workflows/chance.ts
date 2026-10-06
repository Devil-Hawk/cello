// `roles.check_chance` and `roles.gaps` (AG7).
//
//   checkChance  assesses a person's roles in batches of 12, because the chance check reads the
//                posting's requirements against the resume for up to 12 roles at a time.
//   rolesGaps    code over what was stored: which requirements recur among the roles whose chance
//                is Stretch. No model. "Too few to tell" under five assessed roles.
//
// K17b narrows rolesGaps to requirements the record could not find anywhere (Not found items).

import { assessJobs, type AssessJobsArgs, type AssessJobsResult, type RoleFit } from '@/lib/scoring'
import type { AdminClient } from '@/lib/harness/types'

/** How many roles one chance check reads. */
export const CHANCE_BATCH = 12

/** Fewest assessed roles before a recurring gap means anything. */
export const MIN_ROLES_FOR_GAPS = 5

export type CheckChanceArgs = Omit<AssessJobsArgs, 'jobIds' | 'limit'>

export interface CheckChanceResult extends Omit<AssessJobsResult, 'skippedReason'> {
  batches: number
  skippedReason?: AssessJobsResult['skippedReason']
}

/** Checks the chance for these roles, twelve at a time, and adds up what each batch did. */
export async function checkChance(args: CheckChanceArgs, jobIds: readonly string[]): Promise<CheckChanceResult> {
  const unique = [...new Set(jobIds)]
  const total: CheckChanceResult = { assessed: 0, blocked: 0, failed: 0, remaining: 0, fits: new Map<string, RoleFit>(), batches: 0 }
  for (let i = 0; i < unique.length; i += CHANCE_BATCH) {
    const chunk = unique.slice(i, i + CHANCE_BATCH)
    const part = await assessJobs({ ...args, jobIds: chunk, limit: chunk.length })
    total.batches++
    total.assessed += part.assessed
    total.blocked += part.blocked
    total.failed += part.failed
    total.remaining = part.remaining
    for (const [id, fit] of part.fits) total.fits.set(id, fit)
    // A reason that stops every batch (no resume, no key) stops the rest too.
    if (part.skippedReason) {
      total.skippedReason = part.skippedReason
      break
    }
  }
  return total
}

export interface GapLine {
  requirement: string
  /** How many of the Stretch roles name it. */
  roles: number
}

export interface RolesGaps {
  /** Roles with a settled chance among those asked about. */
  assessed: number
  stretch: number
  /** The requirements Stretch roles share, most shared first. Empty when there are too few roles to tell. */
  gaps: GapLine[]
  tooFew: boolean
  /** One sentence for the person, built from the counts. */
  line: string
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ')

/** What recurs among the Stretch roles. Counted by code from the verdicts already stored. */
export async function rolesGaps(admin: AdminClient, userId: string, jobIds: readonly string[]): Promise<RolesGaps> {
  const ids = [...new Set(jobIds)].slice(0, 200)
  if (ids.length === 0) return { assessed: 0, stretch: 0, gaps: [], tooFew: true, line: 'Too few roles to tell.' }
  const { data } = await admin.from('person_roles').select('job_id, chance, chance_detail').eq('user_id', userId).in('job_id', ids)
  const rows = ((data as { job_id: string; chance: string | null; chance_detail: { gaps?: unknown } | null }[] | null) ?? []).filter(
    (r) => r.chance === 'strong' || r.chance === 'possible' || r.chance === 'stretch'
  )
  const stretch = rows.filter((r) => r.chance === 'stretch')
  if (rows.length < MIN_ROLES_FOR_GAPS) return { assessed: rows.length, stretch: stretch.length, gaps: [], tooFew: true, line: `Too few to tell: ${rows.length} of ${MIN_ROLES_FOR_GAPS} roles checked.` }

  const counts = new Map<string, { requirement: string; roles: number }>()
  for (const r of stretch) {
    const gaps = Array.isArray(r.chance_detail?.gaps) ? (r.chance_detail!.gaps as unknown[]).filter((g): g is string => typeof g === 'string') : []
    for (const g of new Set(gaps.map(norm).filter(Boolean))) {
      const key = g.toLowerCase()
      const cur = counts.get(key) ?? { requirement: g, roles: 0 }
      cur.roles++
      counts.set(key, cur)
    }
  }
  const gaps = [...counts.values()].filter((g) => g.roles >= 2).sort((a, b) => b.roles - a.roles || a.requirement.localeCompare(b.requirement))
  const top = gaps[0]
  const line =
    stretch.length === 0
      ? `None of your ${rows.length} checked roles is a Stretch.`
      : top
        ? `${top.roles} of ${stretch.length} Stretch roles name ${top.requirement}.`
        : `${stretch.length} of ${rows.length} checked roles are a Stretch, and no one requirement repeats.`
  return { assessed: rows.length, stretch: stretch.length, gaps, tooFew: false, line }
}
