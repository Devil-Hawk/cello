import { describe, expect, it } from 'vitest'
import { normaliseDept, normaliseTitle, titleKey } from './normalise'

// [raw title, title_norm, level]. The level is classify.ts's, read from the raw title.
const TABLE: [string, string, string][] = [
  ['Software Engineer', 'software engineer', 'unknown'],
  ['Senior Software Engineer', 'software engineer', 'senior'],
  ['Sr. Software Engineer', 'software engineer', 'senior'],
  ['Sr Software Engineer II', 'software engineer', 'senior'],
  ['Staff Software Engineer', 'software engineer', 'staff'],
  ['Principal Engineer', 'engineer', 'principal'],
  ['Software Engineer III', 'software engineer', 'senior'],
  ['Software Engineer II', 'software engineer', 'mid'],
  ['Software Engineer I', 'software engineer', 'unknown'],
  ['Software Engineer L5', 'software engineer', 'unknown'],
  ['Junior Data Analyst', 'data analyst', 'junior'],
  ['Jr. Data Analyst', 'data analyst', 'junior'],
  ['Data Engineering Intern', 'data engineering', 'intern'],
  ['Engineering Manager', 'engineering manager', 'manager'],
  ['Senior Engineering Manager', 'engineering manager', 'manager'],
  ['Director of Engineering', 'director of engineering', 'director'],
  ['Head of Engineering', 'head of engineering', 'director'],
  ['VP Engineering', 'vp engineering', 'exec'],
  ['Lead', '', 'manager'],
  ['Tech Lead', 'engineer', 'manager'],
  ['Backend Tech Lead', 'backend engineer', 'manager'],
  ['Lead Software Engineer', 'software engineer', 'unknown'],
  ['Software Engineer, Lead', 'software engineer', 'manager'],
  ['Sr. Forward Deployed Engineer - NYC (Hybrid)', 'forward deployed engineer', 'senior'],
  ['Senior Software Engineer (Remote)', 'software engineer', 'senior'],
  ['Software Engineer - Remote, US', 'software engineer', 'unknown'],
  ['Software Engineer | Berlin', 'software engineer', 'unknown'],
  ['Software Engineer (m/f/d)', 'software engineer', 'unknown'],
  ['Software Engineer - R-12345', 'software engineer', 'unknown'],
  ['Backend Engineer, Payments', 'backend engineer payments', 'unknown'],
  ['Data Engineer, ML Platform', 'data engineer ml platform', 'unknown'],
  ['Machine Learning Engineer', 'machine learning engineer', 'unknown'],
  ['ML Engineer', 'ml engineer', 'unknown'],
  ['MLE', 'machine learning engineer', 'unknown'],
  ['FDE', 'forward deployed engineer', 'unknown'],
  ['SWE', 'software engineer', 'unknown'],
  ['Software Eng.', 'software engineer', 'unknown'],
  ['Sr. SWE', 'software engineer', 'senior'],
  ['SDE II', 'software engineer', 'mid'],
  ['Staff Engineer', 'engineer', 'staff'],
  ['Member of Technical Staff', 'member of technical staff', 'staff'],
  ['Senior Member of Technical Staff', 'member of technical staff', 'staff'],
  ['AI/ML Engineer', 'ai ml engineer', 'unknown'],
  ['Full-Stack Developer', 'full stack developer', 'unknown'],
  ['Front-End Engineer', 'front end engineer', 'unknown'],
  ['C++ Developer', 'c developer', 'unknown'],
  ['.NET Developer', 'net developer', 'unknown'],
  ['Ingénieur Logiciel Senior', 'ingénieur logiciel', 'senior'],
  ['ソフトウェアエンジニア', 'ソフトウェアエンジニア', 'unknown'],
  ['Softwareentwickler (m/w/d)', 'softwareentwickler', 'unknown'],
  ['Product Manager - Growth (Hybrid, NYC)', 'product manager growth', 'manager'],
  ['Senior Product Manager, AI', 'product manager ai', 'manager'],
  ['Account Executive II', 'account executive', 'mid'],
  ['Principal Software Engineer, Infrastructure', 'software engineer infrastructure', 'principal'],
  ['Engineering Manager (Platform)', 'engineering manager platform', 'manager'],
  ['Software Engineer in Test', 'software engineer in test', 'unknown'],
  ['Senior Data Scientist - Trust & Safety', 'data scientist trust safety', 'senior'],
  ['  SOFTWARE   ENGINEER  ', 'software engineer', 'unknown'],
  ['Ｓｏｆｔｗａｒｅ Ｅｎｇｉｎｅｅｒ', 'software engineer', 'unknown'],
  ['', '', 'unknown'],
]

describe('normaliseTitle', () => {
  it.each(TABLE)('%s -> %s (%s)', (raw, norm, level) => {
    expect(normaliseTitle(raw)).toEqual({ title_norm: norm, level })
  })

  it('has 60 rows of cases', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(60)
  })

  it('keeps a team and cuts a place: the same job in two cities is one key', () => {
    expect(normaliseTitle('Data Engineer - Payments (Berlin)').title_norm).toBe('data engineer payments')
    expect(normaliseTitle('Data Engineer - Payments (Austin, TX)').title_norm).toBe('data engineer payments')
  })

  it('keeps a title that is only a team word: "AI" is not a country here', () => {
    expect(normaliseTitle('Software Engineer, AI').title_norm).toBe('software engineer ai')
    expect(normaliseTitle('Software Engineer - ML').title_norm).toBe('software engineer ml')
  })

  it('bounds a 200-character title and never throws on a non-string', () => {
    const long = normaliseTitle('Senior ' + 'Software Engineer '.repeat(30))
    expect(long.title_norm.length).toBeLessThanOrEqual(120)
    expect(long.title_norm).toBe(long.title_norm.trim())
    expect(normaliseTitle(undefined as unknown as string)).toEqual({ title_norm: '', level: 'unknown' })
  })
})

describe('the key of one judgement', () => {
  it('carries the department only for a title that names no particular job', () => {
    expect(titleKey('member of technical staff', 'applied ai')).toEqual({ title_norm: 'member of technical staff', dept_norm: 'applied ai' })
    expect(titleKey('member of technical staff', 'infrastructure')).toEqual({ title_norm: 'member of technical staff', dept_norm: 'infrastructure' })
    expect(titleKey('backend engineer', 'payments')).toEqual({ title_norm: 'backend engineer', dept_norm: '' })
  })

  it('writes a department the way it writes a title', () => {
    expect(normaliseDept('  Applied AI / Research ')).toBe('applied ai research')
    expect(normaliseDept(null)).toBe('')
    expect(normaliseDept('x'.repeat(300)).length).toBe(80)
  })
})
