import { describe, expect, it } from 'vitest'
import { inferResumeMarkdown } from './import/infer'
import { markdownToPlainText } from './markdown'
import { markdownToResume, textToResume } from './from-markdown'
import { resumeFactText, resumeToMarkdown, resumeToPlainText } from './render'
import { ResumeSchema } from './schema'
import { CANONICAL_RESUME, DOCX_STYLE_MD, PASTE_TEXT, PDF_INFER_MD } from './test-fixtures'

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/
const NOISE = new Set(['present', 'current', 'now', 'today'])

/** Tokens of a text with dates, section titles and markup removed: the word bag. */
function bag(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9'+#.]*/g) ?? [])
    .map((t) => t.replace(/[.']+$/, ''))
    .filter((t) => t && !MONTHS.test(t) && !NOISE.has(t))
    .sort()
}

const SECTION_WORDS = new Set([
  'summary', 'experience', 'education', 'skills', 'projects', 'certifications', 'awards', 'languages',
])

function sourceBag(source: string, dropName?: string): string[] {
  const lines = markdownToPlainText(source)
    .split('\n')
    .filter((l) => !SECTION_WORDS.has(l.trim().toLowerCase()))
  let text = lines.join('\n')
  if (dropName) text = text.replace(dropName, '')
  return bag(text)
}

const FIXTURES: Array<[string, string]> = [
  ['pasted plain text', inferResumeMarkdown(PASTE_TEXT)],
  ['docx style', DOCX_STYLE_MD],
  ['pdf infer', PDF_INFER_MD],
  ['canonical markdown', resumeToMarkdown(CANONICAL_RESUME)],
  [
    'unknown section',
    `# Ada Lovelace\n\nada@example.com\n\n## Summary\n\nMathematician.\n\n## Conference Talks\n\n- Notes on the Analytical Engine\n- A keynote on loops`,
  ],
]

describe('markdownToResume', () => {
  it.each(FIXTURES)('keeps every word of %s (word-bag invariant) and is schema-valid', (_n, md) => {
    const r = markdownToResume(md)
    expect(ResumeSchema.safeParse(r).success).toBe(true)
    expect(bag(resumeFactText(r))).toEqual(sourceBag(md))
  })

  it('round-trips the canonical resume', () => {
    const back = markdownToResume(resumeToMarkdown(CANONICAL_RESUME))
    const strip = (r: typeof back) => ({ ...r, meta: undefined })
    expect(strip(back)).toEqual(strip(CANONICAL_RESUME))
  })

  it('structures the pasted REPRO resume with sections, entries and bullets', () => {
    const r = markdownToResume(inferResumeMarkdown(PASTE_TEXT))
    expect(r.basics).toMatchObject({
      name: 'Jordan Rivera',
      email: 'jordan.rivera@example.com',
      phone: '(206) 555-0142',
    })
    expect(r.basics.location).toEqual({ city: 'Seattle', region: 'WA' })
    expect(r.work.map((w) => [w.position, w.name])).toEqual([
      ['Senior Software Engineer', 'Northwind Analytics'],
      ['Software Engineer', 'Contoso Health'],
      ['Junior Developer', 'Fabrikam Labs'],
    ])
    expect(r.work[0]).toMatchObject({ startDate: '2021-03', current: true, location: 'Seattle, WA' })
    expect(r.work[0].highlights).toHaveLength(3)
    expect(r.work[1]).toMatchObject({ startDate: '2018-06', endDate: '2021-02', current: false })
    expect(r.education[0]).toMatchObject({
      institution: 'University of Washington',
      studyType: 'B.S.',
      area: 'Computer Science',
      startDate: '2012',
      endDate: '2016',
    })
    expect(r.skills.map((s) => s.name)).toEqual(['Languages', 'Platforms', 'Practices'])
    expect(r.skills[0].keywords).toEqual(['Python', 'TypeScript', 'SQL', 'Go'])
  })

  it('puts DOCX sections written at the name level into sections, with ## entries', () => {
    const r = markdownToResume(DOCX_STYLE_MD)
    expect(r.basics.summary).toMatch(/^Product-minded/)
    expect(r.work).toHaveLength(1)
    expect(r.work[0]).toMatchObject({ position: 'Senior Software Engineer', startDate: '2021-03', current: true })
    expect(r.skills[0].name).toBe('Languages')
    expect(r.meta.cello.customSections).toEqual([])
    expect(resumeToMarkdown(r)).toMatch(/^## Summary$/m)
  })

  it('separates the date from a bold title and keeps the wrapped bullet whole', () => {
    const r = markdownToResume(PDF_INFER_MD)
    expect(r.work[0]).toMatchObject({
      position: 'Senior Software Engineer',
      name: 'Northwind Analytics',
      startDate: '2021-03',
      current: true,
    })
    expect(r.work[0].position).not.toMatch(/2021/)
  })

  it('takes a location on its own line under the title and date as the location, not a summary', () => {
    const r = markdownToResume(
      '# Ada\n\n## Experience\n\n**Engineer, Acme Mar 2021 - Present**\n\nSeattle, WA\n\n- shipped it'
    )
    expect(r.work[0]).toMatchObject({ location: 'Seattle, WA', startDate: '2021-03', current: true })
    expect(r.work[0].summary).toBeUndefined()
  })

  it('sets current only when the source says so', () => {
    const md = (dates: string) => `# Ada\n\n## Experience\n\n### Dev, Acme\n\n*${dates}*\n\n- did things`
    expect(markdownToResume(md('Mar 2021 - Current')).work[0].current).toBe(true)
    expect(markdownToResume(md('Mar 2021')).work[0].current).toBe(false)
    expect(markdownToResume(md('Mar 2021 - Jun 2022')).work[0].current).toBe(false)
  })

  it('routes an unknown section into customSections', () => {
    const r = markdownToResume(FIXTURES[4][1])
    expect(r.meta.cello.customSections).toEqual([
      { title: 'Conference Talks', items: ['Notes on the Analytical Engine', 'A keynote on loops'] },
    ])
  })

  describe('a nameless fragment', () => {
    const fragment = 'SUMMARY\nPlatform engineer with ten years of experience.\n\nSKILLS\nGo, SQL'

    it.each([
      ['the profile name', { fullName: 'Grace Hopper', email: 'g@h.org' }, 'Grace Hopper'],
      ['the email local part', { email: 'grace.hopper@navy.mil' }, 'Grace Hopper'],
      ['a placeholder', {}, 'Your Name'],
    ])('falls back to %s and warns', (_n, ctx, expected) => {
      const r = markdownToResume(inferResumeMarkdown(fragment), ctx)
      expect(r.basics.name).toBe(expected)
      expect(r.meta.cello.warnings.join(' ')).toMatch(/could not find your name/)
      expect(ResumeSchema.safeParse(r).success).toBe(true)
      expect(r.basics.summary).toMatch(/Platform engineer/)
    })
  })

  it('takes the name from a Name | contact line', () => {
    const r = markdownToResume('Ada Lovelace | ada@example.com | (555) 010-2030\n\n## Summary\n\nHi there.')
    expect(r.basics).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' })
  })

  describe('a hard-wrapped paste (PDF or text editor)', () => {
    const WRAPPED = [
      'Priya Nair',
      'priya.nair@example.com | 415-555-0199 | San Francisco, CA',
      '',
      'SUMMARY',
      'Data engineer with six years of experience building batch and streaming',
      'pipelines for fintech and health companies. Comfortable owning a system',
      'from design through on-call.',
      '',
      'EXPERIENCE',
      'Staff Data Engineer, Lumen Payments            San Francisco, CA',
      'Jan 2022 - Present',
      '* Led the migration of 140 Airflow DAGs to a managed scheduler with zero',
      '  missed settlement windows.',
      '',
      'Data Engineer, Harbor Health\tRemote',
      'Jun 2018 - Dec 2021',
      '* Wrote the data quality framework used by 12 teams.',
    ].join('\n')

    it('joins the soft-wrapped summary into one line', () => {
      const r = textToResume(WRAPPED)
      expect(r.basics.summary).toBe(
        'Data engineer with six years of experience building batch and streaming pipelines for fintech and health companies. Comfortable owning a system from design through on-call.'
      )
      expect(r.basics.summary).not.toContain('\n')
    })

    it('reads a right-aligned location as the location, not part of the company', () => {
      const r = textToResume(WRAPPED)
      expect(r.work[0]).toMatchObject({
        position: 'Staff Data Engineer',
        name: 'Lumen Payments',
        location: 'San Francisco, CA',
        startDate: '2022-01',
        current: true,
      })
      expect(r.work[1]).toMatchObject({ name: 'Harbor Health', location: 'Remote' })
      expect(resumeToMarkdown(r)).toContain('*San Francisco, CA | Jan 2022 - Present*')
    })
  })

  it('splits a trailing Remote off a single-spaced role line (PDF extraction)', () => {
    const r = textToResume('Ada Lovelace\n\nEXPERIENCE\nData Engineer, Harbor Health Remote\nJun 2018 - Dec 2021\n* Built things.')
    expect(r.work[0]).toMatchObject({ position: 'Data Engineer', name: 'Harbor Health', location: 'Remote' })
  })

  it('renders a legacy summary with newlines as one paragraph', () => {
    const r = markdownToResume('# Ada\n\n## Summary\n\nOne.\n\nTwo.')
    r.basics.summary = 'Line one\nline two\n\nSecond paragraph'
    expect(resumeToMarkdown(r)).toContain('Line one line two\n\nSecond paragraph')
  })
})

// The demo profile's resume_text, as stored: "Title, Company", a blank line, "Place | Dates", then bullets.
const DEMO_PLAIN = `Riley Marsh

Senior Backend / Platform Engineer
riley.marsh@demo.example.com | (206) 555-0142 | Seattle, WA (open to remote, US) | riley-marsh.example.com

Summary

Backend and platform engineer with eight years building high-throughput data services. Most recently led the ingestion and query tier for a multi-tenant analytics product serving 4B events/day, cutting p99 read latency from 1.9s to 310ms while halving infrastructure spend. Comfortable owning a system end to end: schema design, service code, rollout, on-call, and the cost line.

Experience

Staff Software Engineer, Cobalt Harbor Systems

Seattle, WA | Mar 2022 - Present
- Rebuilt the event ingestion pipeline (Kafka to a columnar store) behind a dual-write migration, moving 4B events/day with zero customer-visible downtime and no backfill gaps.
- Designed the sharded query planner that took p99 dashboard reads from 1.9s to 310ms; published the load-shedding policy the whole platform group adopted.
- Cut compute spend 48% by right-sizing the streaming tier and introducing tiered storage for cold partitions, roughly $1.1M/year.
- Ran the on-call rotation for six services and drove incident review; MTTR fell from 74 to 22 minutes over four quarters.
- Mentored four engineers, two of whom were promoted to senior.

Senior Software Engineer, Trellis Point Analytics

Remote | Jun 2019 - Feb 2022
- Owned the metrics API used by every customer-facing dashboard: Go services on Kubernetes, Postgres and ClickHouse behind them, 12k RPS at peak.
- Introduced contract tests and a staged rollout pipeline that took change failure rate from 18% to under 4%.
- Led the SOC 2 workstream for the data plane: audit logging, key rotation, and tenant isolation review across nine services.
- Built the internal query-cost attribution tool that made per-tenant unit economics visible to product for the first time.

Software Engineer, Halden & Reeve

Portland, OR | Aug 2017 - May 2019
- Shipped the billing reconciliation service that closed a recurring six-figure revenue leak from unmatched invoice lines.
- Migrated a monolithic Rails scheduler to a queue-backed Python worker fleet, cutting nightly batch runtime from 6h to 40m.
- First engineer on the internal API gateway; wrote the auth middleware still in use today.

Projects

Tidewater

An open-source CLI that diffs two Postgres query plans and explains the regression in plain language. 2.1k stars.

Slate

A tiny Go library for typed feature flags with compile-time exhaustiveness checks, used in production at two former employers.

Skills

Languages: Go, Python, TypeScript, SQL, some Rust
Data: Postgres, ClickHouse, Kafka, Spark, dbt, Iceberg
Platform: Kubernetes, Terraform, AWS (EKS, S3, RDS, MSK), GitHub Actions
Practice: distributed systems design, performance and cost work, incident command, technical mentoring

Education

B.S. Computer Science, Cascade Ridge University

Portland, OR | 2013 - 2017
- Senior project: a fault-injection harness for stream processors.`

describe('title, blank line, Place | Dates, bullets (the demo resume_text)', () => {
  const r = textToResume(DEMO_PLAIN)

  it('reads each job as its own title, company, place and dates', () => {
    expect(r.work.map((w) => [w.position, w.name, w.location, w.startDate, w.highlights.length])).toEqual([
      ['Staff Software Engineer', 'Cobalt Harbor Systems', 'Seattle, WA', '2022-03', 5],
      ['Senior Software Engineer', 'Trellis Point Analytics', 'Remote', '2019-06', 4],
      ['Software Engineer', 'Halden & Reeve', 'Portland, OR', '2017-08', 3],
    ])
    expect(r.work[0].current).toBe(true)
  })

  it('keeps every bullet under its own employer after parse then render', () => {
    const md = resumeToMarkdown(r)
    const plain = resumeToPlainText(r)
    for (const w of r.work) {
      for (const h of w.highlights) expect(plain).toContain(h)
    }
    // Each employer's heading sits directly above its own first bullet, in the order the person wrote.
    const bulletsIn = (name: string) => r.work.find((w) => w.name === name)!.highlights
    expect(bulletsIn('Cobalt Harbor Systems')[0]).toMatch(/^Rebuilt the event ingestion pipeline/)
    expect(bulletsIn('Trellis Point Analytics')[0]).toMatch(/^Owned the metrics API/)
    expect(bulletsIn('Halden & Reeve')[0]).toMatch(/^Shipped the billing reconciliation/)
    expect(md.indexOf('Cobalt Harbor Systems')).toBeLessThan(md.indexOf('Rebuilt the event ingestion'))
    expect(md.indexOf('Rebuilt the event ingestion')).toBeLessThan(md.indexOf('Trellis Point Analytics'))
    expect(md.indexOf('Trellis Point Analytics')).toBeLessThan(md.indexOf('Owned the metrics API'))
    expect(md.indexOf('Halden & Reeve')).toBeLessThan(md.indexOf('Shipped the billing reconciliation'))
  })

  it('reads the school and the projects as themselves', () => {
    expect(r.education.map((e) => [e.institution, e.location, e.startDate])).toEqual([['Cascade Ridge University', 'Portland, OR', '2013']])
    expect(r.projects.map((p) => p.name)).toEqual(['Tidewater', 'Slate'])
    expect(r.projects[0].description).toMatch(/^An open-source CLI/)
  })
})
