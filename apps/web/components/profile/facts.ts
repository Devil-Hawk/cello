// What Cello knows about you, as rows: a label, a value and where the value came from.
// Every value is read where it lives (profile, preferences, the base resume) and its source is
// worked out by code, so no row can show a fact without saying how it is known. Pure.

import { JOB_FUNCTIONS, SENIORITY_LEVELS } from '@/lib/jobs/classify'
import type { Resume } from '@/lib/resume/schema'
import { resolveConstraints } from '@/lib/scoring/constraints'
import { resolveTargeting } from '@/lib/targeting'

export type FactKey =
  | 'name' | 'headline' | 'level' | 'years' | 'places' | 'workAuth' | 'sponsorship' | 'remote'
  | 'payFloor' | 'roleTypes' | 'leaveOut' | 'mail' | 'model' | 'emailCount'

export type FactInput = 'text' | 'number' | 'list' | 'yesno'
/** Where a correction is written: the profile row, the stated constraints, the targeting, or `preferences.facts`. */
export type FactHome = 'profile' | 'constraints' | 'targeting' | 'facts'

export interface Fact {
  key: FactKey
  label: string
  value: string
  /** "You set this", "From your resume, Base resume", "Cello's read of your resume, Oct 4", "Counted from your email". */
  source: string
  /** Null when the value is read from somewhere Profile does not write (mail, model, counts). */
  correct: { home: FactHome; field: string; input: FactInput } | null
  /** What the Correct box starts with. */
  raw: string
}

export interface FactsInput {
  fullName: string | null
  /** The whole `profiles.preferences`, read on the server. */
  preferences: unknown
  resume: Resume | null
  resumeLabel: string | null
  resumeAt: string | null
  mail: boolean
  model: string | null
  /** Past applications counted from email. Null until that count exists. */
  emailCount: number | null
  now?: Date
}

const LABEL: Record<FactKey, string> = {
  name: 'Name',
  headline: 'Headline',
  level: 'Level',
  years: 'Years of experience',
  places: 'Cities you can work in on site',
  workAuth: 'Work authorization',
  sponsorship: 'Needs sponsorship',
  remote: 'Remote only',
  payFloor: 'Lowest pay, USD a year',
  roleTypes: 'Role types',
  leaveOut: 'What you leave out',
  mail: 'Mail',
  model: 'Model',
  emailCount: 'Applications in your email',
}

/** Where each correctable fact is written. Mail, model and the email count are read, not written, here. */
const CORRECTABLE: Partial<Record<FactKey, { home: FactHome; field: string; input: FactInput }>> = {
  name: { home: 'profile', field: 'full_name', input: 'text' },
  headline: { home: 'facts', field: 'headline', input: 'text' },
  level: { home: 'targeting', field: 'seniority', input: 'list' },
  years: { home: 'facts', field: 'years', input: 'number' },
  places: { home: 'constraints', field: 'onsiteCities', input: 'list' },
  workAuth: { home: 'constraints', field: 'onlyCountries', input: 'list' },
  sponsorship: { home: 'constraints', field: 'needsSponsorship', input: 'yesno' },
  remote: { home: 'constraints', field: 'remoteOnly', input: 'yesno' },
  payFloor: { home: 'constraints', field: 'salaryFloorUsd', input: 'number' },
  roleTypes: { home: 'targeting', field: 'functions', input: 'list' },
  leaveOut: { home: 'constraints', field: 'excludedCompanies', input: 'list' },
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

const record = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})

/** Whole years worked, by code: the union of the work dates, so overlapping jobs count once. */
export function yearsOfWork(resume: Resume, now = new Date()): number | null {
  const month = (d: string) => Number(d.slice(0, 4)) * 12 + (d.length > 4 ? Number(d.slice(5, 7)) - 1 : 0)
  const nowMonth = now.getUTCFullYear() * 12 + now.getUTCMonth()
  const spans = resume.work
    .map((w) => (w.startDate ? ([month(w.startDate), w.current ? nowMonth : month(w.endDate ?? w.startDate)] as const) : null))
    .filter((s): s is readonly [number, number] => s !== null && s[1] >= s[0])
    .sort((a, b) => a[0] - b[0])
  if (spans.length === 0) return null
  let total = 0
  let [from, to] = spans[0]
  for (const [s, e] of spans.slice(1)) {
    if (s > to) {
      total += to - from
      ;[from, to] = [s, e]
    } else to = Math.max(to, e)
  }
  return Math.round((total + to - from) / 12)
}

const yearsText = (n: string) => `${n} ${n === '1' ? 'year' : 'years'}`

export function buildFacts(input: FactsInput): Fact[] {
  const prefs = record(input.preferences)
  const overrides = record(prefs.facts)
  const stated = record(prefs.constraints)
  const c = resolveConstraints(prefs)
  const t = resolveTargeting(prefs)
  const llm = input.resume?.meta.cello.structuredBy === 'llm'
  const fromResume = llm && input.resumeAt ? `Cello's read of your resume, ${day(input.resumeAt)}` : `From your resume, ${input.resumeLabel ?? 'Base resume'}`
  const set = 'You set this'

  const years = input.resume ? yearsOfWork(input.resume, input.now) : null
  // key, value, raw, source. An empty value is left out below.
  const rows: [FactKey, string, string, string][] = [
    ['name', input.fullName?.trim() ?? '', input.fullName?.trim() ?? '', set],
    ['headline', input.resume?.basics.label ?? '', input.resume?.basics.label ?? '', fromResume],
    ['level', t.seniority.join(', '), t.seniority.join(', '), set],
    ['years', years === null ? '' : yearsText(String(years)), years === null ? '' : String(years), `Counted from your resume, ${input.resumeLabel ?? 'Base resume'}`],
    ['places', c.onsiteCities.join(', '), c.onsiteCities.join(', '), set],
    ['workAuth', c.onlyCountries.join(', '), c.onlyCountries.join(', '), set],
    ['sponsorship', c.needsSponsorship ? 'Yes' : 'No', c.needsSponsorship ? 'yes' : 'no', typeof stated.needsSponsorship === 'boolean' ? set : 'Not set yet'],
    ['remote', c.remoteOnly ? 'Yes' : 'No', c.remoteOnly ? 'yes' : 'no', stated.remoteOnly === true || t.remoteOnly ? set : 'Not set yet'],
    ['payFloor', c.salaryFloorUsd === null ? '' : `$${c.salaryFloorUsd.toLocaleString('en-US')}`, c.salaryFloorUsd === null ? '' : String(c.salaryFloorUsd), set],
    ['roleTypes', t.functions.join(', '), t.functions.join(', '), set],
    ['leaveOut', c.excludedCompanies.join(', '), c.excludedCompanies.join(', '), set],
    ['mail', input.mail ? 'Connected' : 'Not connected', '', 'From your connections'],
    ['model', input.model ?? '', '', 'From your settings'],
    ['emailCount', input.emailCount === null ? '' : `${input.emailCount} past applications found in your email`, '', 'Counted from your email'],
  ]

  return rows.flatMap(([key, value, raw, source]): Fact[] => {
    const own = record(overrides[key])
    const corrected = own.origin === 'person' && typeof own.value === 'string' && own.value.trim() ? own.value.trim() : null
    const shown = corrected ? (key === 'years' ? yearsText(corrected) : corrected) : value
    if (!shown) return []
    const home = CORRECTABLE[key]
    return [
      {
        key,
        label: LABEL[key],
        value: shown,
        source: corrected ? 'You corrected this' : source,
        correct: home ?? null,
        raw: corrected ?? raw,
      },
    ]
  })
}

// --- a correction, checked before it is written ---

export type Parsed = { ok: true; value: string | number | boolean | string[] } | { ok: false; error: string }

const LISTS: Record<string, { allowed?: readonly string[]; upper?: boolean; lower?: boolean; max: number }> = {
  seniority: { allowed: SENIORITY_LEVELS, max: 10 },
  functions: { allowed: JOB_FUNCTIONS, max: 12 },
  onlyCountries: { upper: true, max: 60 },
  onsiteCities: { lower: true, max: 30 },
  excludedCompanies: { lower: true, max: 100 },
}

/** Turns what the person typed into the value the field stores, or says what is wrong. */
export function parseCorrection(field: string, input: FactInput, raw: string): Parsed {
  const text = raw.trim()
  if (input === 'yesno') return text === 'yes' || text === 'no' ? { ok: true, value: text === 'yes' } : { ok: false, error: 'Choose yes or no.' }
  if (input === 'number') {
    const max = field === 'years' ? 60 : 5_000_000
    return /^\d{1,7}$/.test(text) && Number(text) <= max ? { ok: true, value: Number(text) } : { ok: false, error: `Use a whole number up to ${max.toLocaleString('en-US')}.` }
  }
  if (input === 'text') {
    return text && text.length <= 200 ? { ok: true, value: text } : { ok: false, error: 'Use 1 to 200 characters.' }
  }
  const rule = LISTS[field]
  const items = [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (rule?.upper ? s.toUpperCase() : rule?.lower || rule?.allowed ? s.toLowerCase() : s)))]
  if (items.length > (rule?.max ?? 30)) return { ok: false, error: `Use at most ${rule?.max ?? 30} items.` }
  if (items.some((s) => s.length > 80)) return { ok: false, error: 'Each item can be up to 80 characters.' }
  if (rule?.allowed) {
    const bad = items.find((s) => !rule.allowed!.includes(s))
    if (bad) return { ok: false, error: `Use only: ${rule.allowed.join(', ')}.` }
  }
  if (rule?.upper && items.some((s) => s.length !== 2)) return { ok: false, error: 'Use two-letter country codes like US, CA.' }
  return { ok: true, value: items }
}
