import { describe, expect, it } from 'vitest'
import {
  CLASSIFIER_VERSION,
  QUALITY_REJECT_THRESHOLD,
  classifyJob,
  isLowQuality,
  parseLocation,
} from './classify'

describe('classifyJob — garbage detection', () => {
  // These exact titles are live in the production DB (32 rows each), synthesized
  // by app/api/scraper/trigger/route.ts from career-site URL path slugs.
  const CITY_TITLES = [
    'Aachen', 'Bielefeld', 'Cologne', 'Köln', 'Dusseldorf', 'Düsseldorf',
    'Hamburg', 'Leipzig', 'Potsdam', 'Berlin', 'Bremen', 'Dresden', 'Freiburg',
    'Karlsruhe', 'Stuttgart', 'Munich', 'München', 'Frankfurt', 'Hannover',
    'Hanover', 'Nuremberg', 'Nürnberg', 'Essen', 'Dortmund', 'Bochum',
    'Augsburg', 'Bonn', 'Mannheim', 'Münster', 'Wiesbaden', 'Kiel', 'Rostock',
    'Jena', 'Ulm', 'Aalen',
  ]

  it.each(CITY_TITLES)('rejects the bare city name %s', (title) => {
    const c = classifyJob({ title })
    expect(c.rejectReason).toBe('city-name-title')
    expect(c.qualityScore).toBeLessThan(QUALITY_REJECT_THRESHOLD)
    expect(isLowQuality(c)).toBe(true)
  })

  const DEPARTMENT_TITLES = [
    'Backend', 'Frontend', 'Android', 'iOS', 'DevOps', 'Fullstack', 'QA',
    'Design', 'Marketing', 'Sales', 'Jobs', 'Karriere', 'Career',
    'Stellenangebote', 'Bewerbung',
  ]

  it.each(DEPARTMENT_TITLES)('rejects the bare department word %s', (title) => {
    const c = classifyJob({ title })
    expect(c.rejectReason).toBe('bare-department-title')
    expect(c.qualityScore).toBeLessThan(QUALITY_REJECT_THRESHOLD)
  })

  it('rejects nav-link titles', () => {
    expect(classifyJob({ title: 'View Job' }).rejectReason).toBe('nav-link-title')
    expect(classifyJob({ title: 'Apply Now' }).rejectReason).toBe('nav-link-title')
    expect(classifyJob({ title: 'Open Positions' }).rejectReason).toBe('nav-link-title')
    expect(classifyJob({ title: 'Marketing Jobs' }).rejectReason).toBe('nav-link-title')
  })

  // Aggregator nav link-text that was living in the jobs table as real rows.
  it.each([
    'Companies Hiring in Germany',
    'Jobs with Relocation Package',
    'Jobs with Salary',
    'Jobs by Locations',
    'Free Job Posting',
    'Browse Jobs',
    'See open roles',
    'Explore open roles',
    'Open Positions',
    'Join now',
    "Don't see an open position you'd like fill",
  ])('rejects aggregator nav text %s', (title) => {
    expect(classifyJob({ title }).rejectReason).toBe('nav-link-title')
  })

  it('rejects a city name carrying a country qualifier', () => {
    expect(classifyJob({ title: 'London, UK' }).rejectReason).toBe('city-name-title')
    expect(classifyJob({ title: 'Toronto, ON' }).rejectReason).toBe('city-name-title')
  })

  it('rejects URL-slug shaped titles', () => {
    expect(classifyJob({ title: 'senior-software-engineer' }).rejectReason).toBe('url-slug-title')
    expect(classifyJob({ title: 'jobs_backend_berlin' }).rejectReason).toBe('url-slug-title')
    expect(classifyJob({ title: 'https://acme.com/careers' }).rejectReason).toBe('url-slug-title')
  })

  it('rejects a title that is only the company name', () => {
    const c = classifyJob({ title: 'epias GmbH', companyName: 'epias GmbH' })
    expect(c.rejectReason).toBe('company-name-title')
  })

  it('rejects an empty title', () => {
    expect(classifyJob({ title: '   ' }).rejectReason).toBe('empty-title')
    expect(classifyJob({ title: '   ' }).qualityScore).toBe(0)
  })

  it('rejects a single unfamiliar word with no role shape', () => {
    expect(classifyJob({ title: 'Zeta' }).rejectReason).toBe('single-word-non-role')
  })
})

describe('classifyJob — legitimate titles survive', () => {
  it('keeps legit single-word titles', () => {
    for (const title of ['Recruiter', 'Analyst', 'Receptionist', 'Counsel', 'Controller']) {
      const c = classifyJob({ title })
      expect(c.rejectReason).toBeUndefined()
      expect(c.qualityScore).toBeGreaterThanOrEqual(QUALITY_REJECT_THRESHOLD)
    }
  })

  it('keeps two-word titles the taxonomy recognizes but that carry no agent noun', () => {
    const c = classifyJob({ title: 'Strategic Finance' })
    expect(c.rejectReason).toBeUndefined()
    expect(c.jobFunction).toBe('finance')
  })

  // Regression: these are real postings that an earlier word-count-based rule
  // rejected. Rejection must stay blocklist-driven, never word-count alone.
  it.each([
    'IT Support', 'Strategic Deals', 'Deal Pricing', 'Strategic Initiatives',
    'Revenue Strategy', 'CRM Expert', 'Professional Services', 'Technical Crew',
    'SDR', 'BDR', 'Open Source Engineer', 'Search Quality Rater',
  ])('keeps the real posting %s', (title) => {
    expect(classifyJob({ title }).rejectReason).toBeUndefined()
  })

  it('keeps non-Latin-script titles instead of calling them empty', () => {
    const c = classifyJob({
      title: 'ソリューションアーキテクト (プリセールス)',
      location: 'Tokyo, Japan',
    })
    expect(c.rejectReason).toBeUndefined()
    expect(c.country).toBe('JP')
  })

  it('classifies a US senior engineering job', () => {
    const c = classifyJob({
      title: 'Senior Software Engineer - Backend',
      location: 'San Francisco, CA',
      description:
        'We are looking for a Senior Software Engineer to join our backend team. ' +
        'You will design and build distributed services in Go and TypeScript, own ' +
        'reliability for critical paths, and mentor other engineers. Full-time role.',
      companyName: 'Acme Inc',
    })
    expect(c.jobFunction).toBe('engineering')
    expect(c.seniority).toBe('senior')
    expect(c.language).toBe('en')
    expect(c.country).toBe('US')
    expect(c.isRemote).toBe(false)
    expect(c.jobType).toBe('full-time')
    expect(c.rejectReason).toBeUndefined()
    expect(c.qualityScore).toBeGreaterThanOrEqual(80)
  })

  it('classifies a German-language job', () => {
    const c = classifyJob({
      title: 'Lokführer (m/w/d)',
      location: 'Berlin, Deutschland',
      description:
        'Wir suchen Mitarbeiter für unseren Standort. Deine Aufgaben umfassen ' +
        'die Betreuung unserer Kunden sowie die Leitung von Projekten. ' +
        'Unbefristete Festanstellung in Vollzeit.',
      companyName: 'FlixTrain',
    })
    expect(c.language).toBe('de')
    expect(c.country).toBe('DE')
    expect(c.rejectReason).toBeUndefined()
    expect(c.qualityScore).toBeGreaterThanOrEqual(QUALITY_REJECT_THRESHOLD)
  })

  it('does not mistake an English posting at a German company for German', () => {
    const c = classifyJob({
      title: 'Senior Java Backend Engineer (m/f/x)',
      location: 'Berlin, Germany',
      description: 'You will build backend services with Java and Spring Boot for our platform team.',
    })
    expect(c.language).toBe('en')
    expect(c.country).toBe('DE')
    expect(c.jobFunction).toBe('engineering')
    expect(c.seniority).toBe('senior')
  })
})

describe('classifyJob — taxonomy', () => {
  it.each([
    ['Data Engineer', 'data'],
    ['Machine Learning Engineer (m/w/d)', 'data'],
    ['Product Manager - Data Platform', 'product'],
    ['Product Designer', 'design'],
    ['Presentation Designer', 'design'],
    ['Product Marketing Manager', 'marketing'],
    ['Account Executive - Acquisition', 'sales'],
    ['Customer Success Manager - Ads Solutions', 'support'],
    ['Technical Recruiter', 'hr'],
    ['Corporate Counsel', 'legal'],
    ['Accounting Manager', 'finance'],
    ['Solutions Architect', 'engineering'],
    ['Staff Software Engineer - Backend', 'engineering'],
    ['Project Coordinator', 'operations'],
  ])('maps %s -> %s', (title, expected) => {
    expect(classifyJob({ title }).jobFunction).toBe(expected)
  })

  it.each([
    ['Werkstudent Softwareentwicklung (m/w/d)', 'intern'],
    ['Chief Technology Officer', 'exec'],
    ['Director of Product, Growth/AI', 'director'],
    ['Principal Engineer - Privacy', 'principal'],
    ['Senior Staff Software Engineer - Delta', 'staff'],
    ['Engineering Manager - Backend', 'manager'],
    ['Sr. Forward Deployed Engineer-Retail', 'senior'],
    ['Finance Associate', 'junior'],
    ['Software Engineer II', 'mid'],
    ['Software Engineer', 'unknown'],
  ])('maps %s -> seniority %s', (title, expected) => {
    expect(classifyJob({ title }).seniority).toBe(expected)
  })
})

describe('parseLocation', () => {
  it.each([
    ['San Francisco, CA', 'US', false],
    ['Austin, TX', 'US', false],
    ['New York, NY', 'US', false],
    ['Remote (US)', 'US', true],
    ['Remote - United States', 'US', true],
    ['Berlin, Germany', 'DE', false],
    ['München', 'DE', false],
    ['London, UK', 'GB', false],
    ['Dublin, Ireland', 'IE', false],
    ['Toronto, ON', 'CA', false],
    ['Bangalore, India', 'IN', false],
    ['Remote, Anywhere', null, true],
    ['', null, false],
  ])('parses %s -> %s (remote=%s)', (location, country, isRemote) => {
    const r = parseLocation(location)
    expect(r.country).toBe(country)
    expect(r.isRemote).toBe(isRemote)
  })
})

describe('contract stability', () => {
  it('exposes a classifier version', () => {
    expect(typeof CLASSIFIER_VERSION).toBe('number')
  })

  it('is deterministic', () => {
    const input = { title: 'Senior Data Scientist', location: 'Remote (US)', description: 'x'.repeat(300) }
    expect(classifyJob(input)).toEqual(classifyJob(input))
  })
})
