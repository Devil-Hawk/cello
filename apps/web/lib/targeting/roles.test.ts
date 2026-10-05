import { describe, expect, it } from 'vitest'
import { EMPTY_TARGETING, type Targeting } from '../targeting'
import { applyRoleTargets, excludedCompanyIds, hasRoleTargets, targetVerdict, type RoleFields } from './roles'

const targets = (over: Partial<Targeting>): Targeting => ({ ...EMPTY_TARGETING, ...over })

// The owner's targets from the live findings: data and engineering, junior and mid.
const OWNER = targets({ functions: ['engineering', 'data'], seniority: ['junior', 'mid'] })

const role = (over: Partial<RoleFields> = {}): RoleFields => ({
  title: 'Data Engineer',
  description: 'Build pipelines.',
  job_function: 'data',
  seniority: 'mid',
  country: 'US',
  language: 'en',
  is_remote: false,
  ...over,
})

describe('hasRoleTargets', () => {
  it('is false with nothing set, and ignores minScore (it needs a model)', () => {
    expect(hasRoleTargets(EMPTY_TARGETING)).toBe(false)
    expect(hasRoleTargets(targets({ minScore: 70 }))).toBe(false)
  })
  it('is true for any role target', () => {
    expect(hasRoleTargets(targets({ functions: ['data'] }))).toBe(true)
    expect(hasRoleTargets(targets({ remoteOnly: true }))).toBe(true)
    expect(hasRoleTargets(targets({ excludedKeywords: ['intern'] }))).toBe(true)
    expect(hasRoleTargets(targets({ excludedCompanies: ['acme'] }))).toBe(true)
  })
})

describe('targetVerdict', () => {
  it('inside: a data role, mid level', () => {
    expect(targetVerdict(role(), OWNER)).toBe('inside')
  })

  it('outside: the London marketing role from the live findings', () => {
    const seo = role({ title: 'SEO Marketing Manager', job_function: 'marketing', seniority: 'manager', country: 'GB' })
    expect(targetVerdict(seo, OWNER)).toBe('outside')
  })

  it('outside: wrong seniority, country, language, or not remote', () => {
    expect(targetVerdict(role({ seniority: 'director' }), OWNER)).toBe('outside')
    expect(targetVerdict(role({ country: 'DE' }), targets({ countries: ['US'] }))).toBe('outside')
    expect(targetVerdict(role({ language: 'de' }), targets({ languages: ['en'] }))).toBe('outside')
    expect(targetVerdict(role({ is_remote: false }), targets({ remoteOnly: true }))).toBe('outside')
  })

  it('unclassified: function other, no country, remote unknown', () => {
    expect(targetVerdict(role({ job_function: 'other' }), OWNER)).toBe('unclassified')
    expect(targetVerdict(role({ job_function: null }), OWNER)).toBe('unclassified')
    expect(targetVerdict(role({ country: null }), targets({ countries: ['US'] }))).toBe('unclassified')
    expect(targetVerdict(role({ is_remote: null }), targets({ remoteOnly: true }))).toBe('unclassified')
    expect(targetVerdict(role({ language: 'unknown' }), targets({ languages: ['en'] }))).toBe('unclassified')
  })

  it('outside beats unclassified', () => {
    const t = targets({ functions: ['data'], countries: ['US'] })
    expect(targetVerdict(role({ job_function: 'other', country: 'DE' }), t)).toBe('outside')
  })

  it('an unmarked title is inside for junior/mid/senior targets, unclassified for director-only', () => {
    const plain = role({ title: 'Data Scientist', seniority: 'unknown' })
    expect(targetVerdict(plain, OWNER)).toBe('inside')
    expect(targetVerdict({ ...plain, seniority: null }, OWNER)).toBe('inside')
    expect(targetVerdict(plain, targets({ seniority: ['director'] }))).toBe('unclassified')
  })

  it('an excluded keyword in the title or the description is outside', () => {
    const t = targets({ excludedKeywords: ['unpaid'] })
    expect(targetVerdict(role({ title: 'Unpaid Intern' }), t)).toBe('outside')
    expect(targetVerdict(role({ description: 'This role is UNPAID.' }), t)).toBe('outside')
    expect(targetVerdict(role(), t)).toBe('inside')
  })

  it('an excluded company is outside', () => {
    const t = targets({ excludedCompanies: ['acme'] })
    expect(targetVerdict(role(), t, 'Acme Corp')).toBe('outside')
    expect(targetVerdict(role(), t, 'Globex')).toBe('inside')
  })

  it('with no targets everything is inside', () => {
    expect(targetVerdict(role({ job_function: 'other', country: null, is_remote: null }), EMPTY_TARGETING)).toBe('inside')
    expect(targetVerdict(role({ job_function: 'marketing' }), EMPTY_TARGETING)).toBe('inside')
  })
})

// ---------------------------------------------------------------------------
// applyRoleTargets must select exactly the rows targetVerdict calls inside.
// A recorder keeps the calls; a small evaluator runs them over rows.
// ---------------------------------------------------------------------------

type Row = RoleFields & { id: string; company_id: string }
type Pred = (r: Row) => boolean

function recorder() {
  const preds: Pred[] = []
  const calls: unknown[][] = []
  const q = {
    in(col: string, vals: readonly string[]) {
      calls.push(['in', col, vals])
      preds.push((r) => vals.includes(String((r as never)[col])))
      return q
    },
    eq(col: string, v: unknown) {
      calls.push(['eq', col, v])
      preds.push((r) => (r as never)[col] === v)
      return q
    },
    not(col: string, op: string, v: unknown) {
      calls.push(['not', col, op, v])
      if (op === 'ilike') {
        const k = String(v).slice(1, -1).toLowerCase()
        preds.push((r) => !String((r as never)[col] ?? '').toLowerCase().includes(k))
      } else if (op === 'in') {
        const ids = String(v).slice(1, -1).split(',')
        preds.push((r) => !ids.includes(String((r as never)[col])))
      }
      return q
    },
    or(f: string) {
      calls.push(['or', f])
      const m = /^description\.is\.null,description\.not\.ilike\.%(.*)%$/.exec(f)
      if (m) {
        const k = m[1].toLowerCase()
        preds.push((r) => r.description == null || !r.description.toLowerCase().includes(k))
        return q
      }
      const s = /^seniority\.in\.\((.*)\),seniority\.eq\.unknown,seniority\.is\.null$/.exec(f)
      if (s) {
        const vals = s[1].split(',')
        preds.push((r) => r.seniority == null || r.seniority === 'unknown' || vals.includes(r.seniority))
        return q
      }
      throw new Error(`unhandled or: ${f}`)
    },
  }
  return { q, calls, matches: (r: Row) => preds.every((p) => p(r)) }
}

describe('applyRoleTargets', () => {
  it('records the exact filters for the owner targets', () => {
    const { q, calls } = recorder()
    applyRoleTargets(q, OWNER)
    expect(calls).toEqual([
      ['in', 'job_function', ['engineering', 'data']],
      ['or', 'seniority.in.(junior,mid),seniority.eq.unknown,seniority.is.null'],
    ])
  })

  it('does nothing with no targets', () => {
    const { q, calls } = recorder()
    applyRoleTargets(q, EMPTY_TARGETING)
    expect(calls).toEqual([])
  })

  const rows: Row[] = [
    { id: '1', company_id: 'a', ...role() },
    { id: '2', company_id: 'a', ...role({ job_function: 'marketing' }) },
    { id: '3', company_id: 'a', ...role({ job_function: 'other' }) },
    { id: '4', company_id: 'a', ...role({ seniority: 'unknown' }) },
    { id: '5', company_id: 'a', ...role({ seniority: 'director' }) },
    { id: '6', company_id: 'b', ...role({ country: 'GB' }) },
    { id: '7', company_id: 'a', ...role({ country: null }) },
    { id: '8', company_id: 'a', ...role({ title: 'Unpaid Data Engineer' }) },
    { id: '9', company_id: 'a', ...role({ description: null, is_remote: true }) },
    { id: '10', company_id: 'a', ...role({ is_remote: null, seniority: null }) },
  ]
  const configs: Array<[string, Targeting]> = [
    ['owner', OWNER],
    ['owner + US', { ...OWNER, countries: ['US'] }],
    ['remote only', targets({ remoteOnly: true })],
    ['keyword', targets({ excludedKeywords: ['unpaid'] })],
    ['director only', targets({ seniority: ['director'] })],
    ['excluded company', targets({ functions: ['data'], excludedCompanies: ['globex'] })],
  ]

  it.each(configs)('selects what targetVerdict calls inside: %s', (_name, t) => {
    const names: Record<string, string> = { a: 'Acme', b: 'Globex' }
    const excluded = excludedCompanyIds(
      Object.entries(names).map(([id, name]) => ({ id, name })),
      t
    )
    const { q, matches } = recorder()
    applyRoleTargets(q, t, excluded)
    const bySql = rows.filter(matches).map((r) => r.id)
    const byVerdict = rows.filter((r) => targetVerdict(r, t, names[r.company_id]) === 'inside').map((r) => r.id)
    expect(bySql).toEqual(byVerdict)
  })
})
