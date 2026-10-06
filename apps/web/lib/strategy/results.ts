// What Applications > What is working reads (blueprint 4.8): the findings with the state of each in the person's
// learnings, and the two groups that replace main's source and fit charts, "Where your roles come from" and "How your
// roles spread". All counted by code over the person's kept roles and applications; no model writes a number.

import type { Learning } from '@/lib/learning/types'
import { findingsFrom, type Finding, type Findings } from './findings'
import type { Shape } from './shape'
import type { StrategyReport } from './types'

export interface GroupRow {
  id: string
  label: string
  n: number
  /** Where See them opens Roles, only when Roles can filter by it. */
  href: string | null
}

/** One kept role as read: its chance and where it came from. */
export interface KeptRole {
  chance: string | null
  jobs: { employer_id: string | null; company_id: string | null; source: string | null; source_tier: string | null } | null
}

/** The employers and companies the person follows, as Roles reads them: a directory employer by its id, else the person's own company row. */
export interface Followed {
  employers: Set<string>
  companies: Set<string>
}

const PASTED = new Set(['manual', 'paste', 'pasted', 'url'])

/**
 * Kept roles by where they came from, each counted once, in this order: roles at an employer you follow; roles you
 * pasted; roles from a job board that Cello traced to the employer's own posting; roles from the verified directory's
 * employer boards; and the rest, which could not be traced to an employer. Roles can filter by the first only.
 */
export function sourceGroups(rows: KeptRole[], followed: Followed): GroupRow[] {
  const n = { followed: 0, pasted: 0, traced: 0, directory: 0, untraced: 0 }
  for (const r of rows) {
    const j = r.jobs
    if ((j?.employer_id && followed.employers.has(j.employer_id)) || (j?.company_id && followed.companies.has(j.company_id))) n.followed++
    else if (j?.source && PASTED.has(j.source)) n.pasted++
    else if (j?.employer_id && j.source_tier === 'listing') n.traced++
    else if (j?.employer_id) n.directory++
    else n.untraced++
  }
  const all: GroupRow[] = [
    { id: 'followed', label: "Employers you follow, from their own sites", n: n.followed, href: '/roles?following=1' },
    { id: 'directory', label: 'The directory of employers Cello checks', n: n.directory, href: null },
    { id: 'traced', label: 'Job boards, traced to the employer', n: n.traced, href: null },
    { id: 'pasted', label: 'Links you pasted', n: n.pasted, href: null },
    { id: 'untraced', label: 'Not traced to an employer', n: n.untraced, href: null },
  ]
  return all.filter((g) => g.n > 0)
}

/** Kept roles by Cello's call on your chance, and how many are not checked yet. */
export function spreadGroups(rows: KeptRole[]): GroupRow[] {
  const n = { strong: 0, possible: 0, stretch: 0, unchecked: 0 }
  for (const r of rows) {
    if (r.chance === 'strong' || r.chance === 'possible' || r.chance === 'stretch') n[r.chance]++
    else n.unchecked++
  }
  const all: GroupRow[] = [
    { id: 'strong', label: 'Strong', n: n.strong, href: '/roles?chance=strong' },
    { id: 'possible', label: 'Possible', n: n.possible, href: '/roles?chance=possible' },
    { id: 'stretch', label: 'Stretch', n: n.stretch, href: '/roles?chance=stretch' },
    { id: 'unchecked', label: 'Not checked yet', n: n.unchecked, href: null },
  ]
  return all.filter((g) => g.n > 0)
}

export type FindingState = 'new' | 'kept'

export interface ViewFinding extends Finding {
  state: FindingState
}

export interface ResultsView {
  working: ViewFinding[]
  notWorking: ViewFinding[]
  noticed: ViewFinding[]
  thresholds: string[]
  source: GroupRow[]
  spread: GroupRow[]
}

/** The learning that records the person's choice on one finding: Keep makes it active, Not right makes it off. */
export const choiceKey = (findingKey: string) => `kept:${findingKey}`

/**
 * The findings as the person sees them. A finding the person said was not right (their choice is off) is not shown;
 * one they kept reads as kept. Both are read from the person's learnings by the finding's key.
 */
export function viewFrom(report: StrategyReport, shape: Shape, learnings: Pick<Learning, 'key' | 'status'>[], kept: KeptRole[], followed: Followed): ResultsView {
  const status = new Map(learnings.map((l) => [l.key, l.status]))
  const f: Findings = findingsFrom(report, shape)
  const show = (xs: Finding[]): ViewFinding[] => xs.filter((x) => status.get(choiceKey(x.key)) !== 'off').map((x) => ({ ...x, state: status.get(choiceKey(x.key)) === 'active' ? 'kept' : 'new' }))
  return { working: show(f.working), notWorking: show(f.notWorking), noticed: show(f.noticed), thresholds: f.thresholds, source: sourceGroups(kept, followed), spread: spreadGroups(kept) }
}
