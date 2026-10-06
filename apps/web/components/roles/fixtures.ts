// Made-up roles for the Roles and record fixtures and their tests. No company
// here is real, and nothing reads a database.

import type { RecordData } from './record/record-view'
import type { RoleItem } from './types'

const TITLES = [
  'AI Engineer',
  'Forward Deployed Engineer',
  'Senior Data Engineer',
  'Machine Learning Engineer, Ranking',
  'Platform Engineer',
  'Analytics Engineer',
  'Staff Software Engineer, Applied AI and Developer Experience for Regulated Industries',
]

// The type each title would get, and who typed it: the second is a model's, so it carries the read mark.
const TYPES: Array<{ id: string; label: string; origin: 'code' | 'model' }> = [
  { id: 'ai-engineer', label: 'AI Engineer', origin: 'code' },
  { id: 'forward-deployed-engineer', label: 'Forward Deployed Engineer', origin: 'model' },
  { id: 'data-engineer', label: 'Data Engineer', origin: 'code' },
  { id: 'ml-engineer', label: 'ML Engineer', origin: 'code' },
  { id: 'platform-engineer', label: 'Platform or Infrastructure Engineer', origin: 'code' },
  { id: 'analytics-engineer', label: 'Analytics Engineer', origin: 'code' },
  { id: 'software-engineer', label: 'Software Engineer', origin: 'code' },
]

/** The choices Change type and the Role type filter offer in the fixtures. */
export const fixtureTypeOptions = TYPES.map(({ id, label }) => ({ id, label }))

/** The employer id of the nth fixture employer. */
export const employerId = (n: number) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`

export function fixtureRoles(count: number, employers: number): RoleItem[] {
  return Array.from({ length: count }, (_, i) => {
    const e = employers === 0 ? null : i % employers
    return {
      id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      title: TITLES[i % TITLES.length],
      company: e === null ? 'Lone Studio' : `Fixture Employer ${e + 1}`,
      companyId: e === null ? null : employerId(e),
      domain: null,
      logoUrl: null,
      location: i % 3 === 0 ? 'Remote, US' : 'New York',
      postedAt: new Date(Date.UTC(2026, 9, 5) - i * 3_600_000).toISOString(),
      pay: i % 2 === 0 ? '$187,000 to $240,000 a year' : null,
      level: i % 2 === 0 ? 'senior' : null,
      type: { ...TYPES[i % TYPES.length], own: false },
      pasted: false,
      legit: null,
      chance: i % 4 === 0 ? 'strong' : i % 4 === 1 ? 'possible' : null,
      wantP: i % 4 === 3 ? null : 0.9 - (i % 10) / 20,
      read: i % 4 === 0 ? 'Looks like what you go for.' : null,
      savedAt: null,
      hiddenReason: null,
      closed: false,
      reaction: null,
    }
  })
}

/** The count each role type would show: here, exactly the rows given. */
export function fixtureTypeCounts(items: readonly RoleItem[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) if (i.type) out[i.type.id] = (out[i.type.id] ?? 0) + 1
  return out
}

/** The count each employer would show: here, exactly the rows given. */
export function fixtureCounts(items: readonly RoleItem[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) if (i.companyId) out[i.companyId] = (out[i.companyId] ?? 0) + 1
  return out
}

const PARAGRAPH =
  'You will build the systems that read a posting and decide, with evidence, whether a person is a fit. We work in small teams, ship weekly and keep a short list of things we will not do.'

/** A posting of at least `chars` characters, with headings, a list and a table. */
export function fixturePosting(chars = 2400): string {
  const head = ['## About the role', PARAGRAPH, '## What you will do', '- Own the ranking service end to end', '- Write the evaluation that tells us when it is wrong', '- Talk to the people who use it', '## Pay', '| Level | Range |', '| --- | --- |', '| Senior | $187,000 to $240,000 |'].join('\n\n')
  let out = head
  while (out.length < chars) out += `\n\n${PARAGRAPH}`
  return out
}

/** One role's record, made up. Pass overrides for the states a test needs. */
export function fixtureRecord(over: Partial<RecordData> = {}): RecordData {
  const role = { ...fixtureRoles(1, 1)[0], title: 'AI Engineer', company: 'Vantage Loom', chance: 'possible' as const, read: 'Looks like what you go for.' }
  return {
    role,
    url: 'https://vantageloom.example/careers/ai-engineer',
    description: fixturePosting(),
    tier: 'board',
    checkedAt: new Date(Date.UTC(2026, 9, 5, 9)).toISOString(),
    place: 'New York or remote, US',
    remote: true,
    status: null,
    why: 'Kept: Engineering is one of your role types, and Senior is your level.',
    sponsorship: [],
    employer: { open: 636, forYou: 12 },
    people: [{ id: 'p1', name: 'Priya Nair', title: 'Engineering manager', how: 'In your contacts' }],
    history: [{ at: new Date(Date.UTC(2026, 8, 12)).toISOString(), text: 'You applied to Platform Engineer. Status: applied.' }],
    ...over,
  }
}
