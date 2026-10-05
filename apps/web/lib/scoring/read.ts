// Reading the verdict on a role. The assessment lives on the job row (see
// migration 20261006000200), so every screen selects FIT_COLUMNS next to the
// columns it already reads and passes the row through parseFit. Nothing here
// produces a number to show: the chance is a label with evidence, and the want
// is a band.

import { wantTier } from './shortlist'
import type { BlockReason, Chance, RequirementCheck, RoleFit } from './types'

/** The jobs columns that hold the verdict. Add to a select string. */
export const FIT_COLUMNS = 'fit_assessed_at, blocked_reasons, want_p, want_reason, want_detail, chance, chance_detail'

export interface FitRow {
  id?: string | null
  fit_assessed_at?: string | null
  blocked_reasons?: unknown
  want_p?: number | null
  want_reason?: string | null
  want_detail?: unknown
  chance?: string | null
  chance_detail?: unknown
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
}

function blockReasons(v: unknown): BlockReason[] {
  if (!Array.isArray(v)) return []
  const out: BlockReason[] = []
  for (const x of v) {
    const o = obj(x)
    if (typeof o.text === 'string' && typeof o.kind === 'string') out.push({ kind: o.kind as BlockReason['kind'], text: o.text })
  }
  return out
}

function checks(v: unknown): RequirementCheck[] {
  if (!Array.isArray(v)) return []
  const out: RequirementCheck[] = []
  for (const x of v) {
    const o = obj(x)
    if (typeof o.requirement !== 'string') continue
    const ev = obj(o.evidence)
    out.push({
      requirement: o.requirement,
      mustHave: o.mustHave !== false,
      status: (['met', 'partial', 'not_met', 'unclear'] as const).includes(o.status as 'met') ? (o.status as RequirementCheck['status']) : 'unclear',
      evidence: typeof ev.line === 'number' && typeof ev.quote === 'string' ? { line: ev.line, quote: ev.quote } : null,
    })
  }
  return out
}

const CHANCES: readonly Chance[] = ['strong', 'possible', 'stretch', 'cannot_assess']

/** Turns the verdict columns of a job row into what a screen needs. Tolerates null columns: an unassessed role has no want and no chance. */
export function parseFit(row: FitRow): RoleFit {
  const detail = obj(row.chance_detail)
  const want = obj(row.want_detail)
  const p = typeof row.want_p === 'number' && Number.isFinite(row.want_p) ? row.want_p : null
  const label = CHANCES.includes(row.chance as Chance) ? (row.chance as Chance) : null
  return {
    jobId: row.id ?? null,
    assessedAt: row.fit_assessed_at ?? null,
    blocked: blockReasons(row.blocked_reasons),
    want:
      p == null
        ? null
        : {
            p,
            reason: typeof row.want_reason === 'string' && row.want_reason.trim() ? row.want_reason.trim() : null,
            tier: wantTier(p),
            calibrated: want.calibrated === true,
            nReactions: typeof want.nReactions === 'number' ? want.nReactions : 0,
          },
    chance:
      label == null
        ? null
        : {
            label,
            checks: checks(detail.checks),
            gaps: strings(detail.gaps),
            confirm: strings(detail.confirm),
            note: typeof detail.note === 'string' ? detail.note : null,
          },
  }
}

/** A fit that carries only a chance label, for lists that show the chip and nothing else. */
export function fitFromLabel(label: string | null | undefined): RoleFit {
  const valid = CHANCES.includes(label as Chance) ? (label as Chance) : null
  return { jobId: null, assessedAt: null, blocked: [], want: null, chance: valid ? { label: valid, checks: [], gaps: [], confirm: [], note: null } : null }
}

export type ChanceWord = 'Strong' | 'Possible' | 'Stretch' | 'Not assessed yet'

/** The word a chip shows. A role that could not be checked, or has not been, says so. */
export function chanceLabel(c: Pick<NonNullable<RoleFit['chance']>, 'label'> | Chance | null | undefined): ChanceWord {
  const label = c == null ? null : typeof c === 'string' ? c : c.label
  switch (label) {
    case 'strong':
      return 'Strong'
    case 'possible':
      return 'Possible'
    case 'stretch':
      return 'Stretch'
    default:
      return 'Not assessed yet'
  }
}

/** The requirements the resume shows, each as "requirement: the resume line that shows it". Used to ground outreach on real evidence. */
export function fitHighlights(chanceDetail: unknown, max = 4): string[] {
  return checks(obj(chanceDetail).checks)
    .filter((c) => c.status === 'met' && c.evidence)
    .slice(0, max)
    .map((c) => `${c.requirement}: ${c.evidence!.quote}`)
}

/** One line per band for the places that explain how strongly a role is wanted, in words rather than a number. */
export const WANT_TIER_COPY = {
  high: 'Looks like what you go for',
  medium: 'Might be what you want',
  low: 'Not much like what you go for',
} as const

/** The first gap, phrased for a tooltip on a Possible or Stretch chip. */
export function firstGapCopy(fit: RoleFit): string | null {
  const gap = fit.chance?.gaps.find((g) => !g.startsWith('Nice to have')) ?? fit.chance?.gaps[0]
  if (!gap) return null
  return `Not clearly on your resume: ${gap.replace(/^(?:Only partly shown|Nice to have):\s*/i, '').replace(/[.]+$/, '')}.`
}

/** The jobs columns a verdict fills, for a screen that has just assessed a role and wants its row to show it without a reload. */
export function fitToColumns(fit: RoleFit): Required<Omit<FitRow, 'id'>> {
  return {
    fit_assessed_at: fit.assessedAt,
    blocked_reasons: fit.blocked,
    want_p: fit.want?.p ?? null,
    want_reason: fit.want?.reason ?? null,
    want_detail: fit.want ? { calibrated: fit.want.calibrated, nReactions: fit.want.nReactions } : null,
    chance: fit.chance?.label ?? null,
    chance_detail: fit.chance ? { checks: fit.chance.checks, gaps: fit.chance.gaps, confirm: fit.chance.confirm, note: fit.chance.note } : null,
  }
}
