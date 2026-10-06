import { describe, expect, it } from 'vitest'
import { NOT_READ_YET, TOO_FEW, fromReaderRequirements, quoteIsIn } from './posting-requirements'

function record(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: 'deterministic',
    skills_resolved: true,
    must_have: ['Go', 'PostgreSQL'],
    nice_to_have: ['Kubernetes'],
    years_experience: { min: null, max: null },
    seniority: null,
    location: { mode: null, places: [] },
    visa: { sponsorship: 'not_stated', evidence: null },
    salary: null,
    ...over,
  }
}

describe('fromReaderRequirements', () => {
  it('is thin, with a plain reason, when the reader has not stored anything or stored something else', () => {
    expect(fromReaderRequirements(null)).toEqual({ kind: 'thin', reason: NOT_READ_YET })
    expect(fromReaderRequirements(undefined)).toEqual({ kind: 'thin', reason: NOT_READ_YET })
    expect(fromReaderRequirements({ version: 7, must_have: ['Go'] })).toEqual({ kind: 'thin', reason: NOT_READ_YET })
    expect(fromReaderRequirements('Go and Rust')).toEqual({ kind: 'thin', reason: NOT_READ_YET })
  })

  it('lists must haves first, then the years asked for, then nice to haves, each a skill or experience item', () => {
    const out = fromReaderRequirements(record({ years_experience: { min: 5, max: null } }))
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.requirements.map((r) => [r.id, r.text, r.kind, r.mustHave])).toEqual([
      ['r1', 'Go', 'skill', true],
      ['r2', 'PostgreSQL', 'skill', true],
      ['r3', '5+ years of experience', 'experience', true],
      ['r4', 'Kubernetes', 'skill', false],
    ])
    expect(out.requirements.every((r) => r.origin === 'code')).toBe(true)
  })

  it('marks the skills a model found for the reader, and only those', () => {
    const out = fromReaderRequirements(record({ source: 'mixed', years_experience: { min: 3, max: null } }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.requirements.find((r) => r.text === 'Go')!.origin).toBe('model')
    expect(out.requirements.find((r) => r.kind === 'experience')!.origin).toBe('code')
  })

  it('adds work authorization, with the posting\'s own sentence as its quote, when sponsorship is not offered', () => {
    const out = fromReaderRequirements(record({ visa: { sponsorship: 'not_offered', evidence: 'We cannot sponsor visas.' } }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    const auth = out.requirements.find((r) => r.kind === 'authorization')
    expect(auth).toMatchObject({ text: 'Work authorization without sponsorship', mustHave: true, quote: 'We cannot sponsor visas.' })
    expect(fromReaderRequirements(record({ visa: { sponsorship: 'offered', evidence: 'Visa sponsorship is available.' } }))).toMatchObject({ kind: 'ok' })
    const offered = fromReaderRequirements(record({ visa: { sponsorship: 'offered', evidence: 'Visa sponsorship is available.' } }))
    if (offered.kind === 'ok') expect(offered.requirements.some((r) => r.kind === 'authorization')).toBe(false)
  })

  it('is thin when fewer than two things can be checked, even with a visa line', () => {
    expect(fromReaderRequirements(record({ must_have: ['Go'], nice_to_have: [] }))).toEqual({ kind: 'thin', reason: TOO_FEW })
    expect(fromReaderRequirements(record({ must_have: [], nice_to_have: [], visa: { sponsorship: 'not_offered', evidence: 'No sponsorship.' } }))).toEqual({ kind: 'thin', reason: TOO_FEW })
  })

  it('keeps at most twelve items, authorization included', () => {
    const many = Array.from({ length: 25 }, (_, i) => 'Skill ' + i)
    const out = fromReaderRequirements(record({ must_have: many, nice_to_have: [], visa: { sponsorship: 'not_offered', evidence: 'No sponsorship.' } }))
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.requirements).toHaveLength(12)
    expect(out.requirements[11].kind).toBe('authorization')
  })

  it('never calls anything: the same record always gives the same answer', () => {
    const r = record({ years_experience: { min: 2, max: 4 } })
    expect(fromReaderRequirements(r)).toEqual(fromReaderRequirements(r))
  })
})

describe('quoteIsIn', () => {
  it('finds a quote ignoring case, spacing and curly punctuation', () => {
    expect(quoteIsIn('strong go', 'We want  Strong   Go skills')).toBe(true)
    expect(quoteIsIn('it’s a plus', "It's a plus to know Rust")).toBe(true)
  })
  it('refuses a quote that is not there or is too short to mean anything', () => {
    expect(quoteIsIn('Rust experience', 'We use Go and Java')).toBe(false)
    expect(quoteIsIn('Go', 'We use Go')).toBe(false)
  })
})
