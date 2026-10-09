// The faithfulness check on model output: is it a REFORMAT of the user's resume
// or a different resume? That check is what stands between a model and the
// user's document, so it is tested against real attacks.

import { describe, expect, it } from 'vitest'
import { checkReformatFaithfulness, stripCodeFence } from './llm'

const SOURCE = `Jane Q. Doe
jane.doe@example.com | 555-0100 | Seattle, WA

EXPERIENCE

Senior Engineer, Northwind Payments
Mar 2019 - Present
• Led the migration of the ledger service to Postgres.
• Cut settlement latency from 900ms to 120ms.

Engineer, Contoso
2015 - 2019
• Built the refunds API used by 40 internal teams.

EDUCATION
B.S. Computer Science, University of Washington, 2015`

const FAITHFUL = `# Jane Q. Doe

jane.doe@example.com | 555-0100 | Seattle, WA

## EXPERIENCE

**Senior Engineer, Northwind Payments — Mar 2019 - Present**

- Led the migration of the ledger service to Postgres.
- Cut settlement latency from 900ms to 120ms.

**Engineer, Contoso — 2015 - 2019**

- Built the refunds API used by 40 internal teams.

## EDUCATION

B.S. Computer Science, University of Washington, 2015`

describe('checkReformatFaithfulness', () => {
  it('passes a real reformat', () => {
    const report = checkReformatFaithfulness(SOURCE, FAITHFUL)
    expect(report.ok).toBe(true)
    expect(report.reason).toBeNull()
    expect(report.retention).toBeGreaterThan(0.95)
  })

  it('passes text whose reading order changed (a two-column PDF read visually)', () => {
    const shuffled = SOURCE.split('\n').reverse().join('\n')
    expect(checkReformatFaithfulness(SOURCE, shuffled).ok).toBe(true)
  })

  it('rejects an answer that invented an employer and achievements', () => {
    const invented = `${FAITHFUL}

**Principal Architect, Globex Aerospace — 2023 - Present**

- Designed a multi-region telemetry pipeline ingesting 4 billion satellite events daily.
- Mentored fourteen distinguished engineers across three continents.
- Won the Globex Chairman Innovation Trophy for orbital scheduling research.`
    const report = checkReformatFaithfulness(SOURCE, invented)
    expect(report.ok).toBe(false)
    // Containment now rejects this before the ratios get a look in, and names
    // the invented facts rather than quoting a percentage — a strictly better
    // rejection, so this asserts the new wording deliberately.
    expect(report.reason).toMatch(/not in your document/)
    expect(report.invented).not.toHaveLength(0)
  })

  it('rejects an answer that silently dropped most of the resume', () => {
    const truncated = '# Jane Q. Doe\n\n## EDUCATION\n\nB.S. Computer Science, University of Washington, 2015'
    const report = checkReformatFaithfulness(SOURCE, truncated)
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/survived/)
  })

  it('rejects an empty answer', () => {
    expect(checkReformatFaithfulness(SOURCE, '   ').ok).toBe(false)
  })
})

describe('stripCodeFence', () => {
  it('removes a fence the model added anyway', () => {
    expect(stripCodeFence('```markdown\n# Jane\n\n- a\n```')).toBe('# Jane\n\n- a')
    expect(stripCodeFence('# Jane')).toBe('# Jane')
  })
})


// ---------------------------------------------------------------------------
// Fabrication attacks
// ---------------------------------------------------------------------------
// Every case below was measured PASSING the word-set ratios with ok=true and
// zero warnings before findInventedFacts existed: an entirely invented third
// employer scored retention 1.000 / novelty 0.055, and a metric moved from 62%
// to 92% scored 0.992 / 0.008. Ratios divide by the OUTPUT's vocabulary, so a
// targeted lie is arithmetically invisible no matter how the thresholds are
// tuned. These are regression tests for the class, not for the constants —
// if someone "simplifies" the containment check back to ratios, they all fail.

const SOURCE_RESUME = `Jane Okafor
Seattle, WA | jane.okafor@example.com

WORK EXPERIENCE

Globex Corporation - Engineer II - 2018 - 2021
Cut checkout latency by 62% across the payments path.
Owned the migration of the ledger service.

Hooli - Senior Software Engineer - 2021 - Present
Led a team of four on the billing platform.

EDUCATION
Bachelor of Science, Computer Science, University of Washington, 2018

SKILLS
Python, PostgreSQL, Docker`

describe('findInventedFacts — targeted resume lies', () => {
  const attacks: Array<[string, string]> = [
    [
      'an entirely fabricated employer, title and dates',
      '**Initech LLC, Austin TX - Principal Architect - 2013 - 2016**',
    ],
    ['a degree upgraded to a Master of Science', 'Master of Science, Computer Science, 2018'],
    ['an employer renamed to a more impressive one', '**Google - Engineer II - 2018 - 2021**'],
    ['a job title inflated to Director', '**Globex Corporation - Director of Engineering - 2018 - 2021**'],
    ['a metric inflated from 62% to 92%', '- Cut checkout latency by 92% across the payments path.'],
    ['tenure dates shifted earlier', '**Globex Corporation - Engineer II - 2015 - 2021**'],
    ['invented skills appended', 'Python, PostgreSQL, Docker, Kubernetes, Terraform'],
  ]

  it.each(attacks)('rejects %s', (_label, fabricated) => {
    const output = `# Jane Okafor\n\n## Work Experience\n\n${fabricated}\n`
    const report = checkReformatFaithfulness(SOURCE_RESUME, output)

    expect(report.ok).toBe(false)
    expect(report.invented.length).toBeGreaterThan(0)
    expect(report.reason).toMatch(/not in your document/i)
  })

  it('does not flag a faithful reformat that only adds structure', () => {
    const faithful = `# Jane Okafor

Seattle, WA | jane.okafor@example.com

## Work Experience

**Globex Corporation - Engineer II - 2018 - 2021**

- Cut checkout latency by 62% across the payments path.
- Owned the migration of the ledger service.

**Hooli - Senior Software Engineer - 2021 - Present**

- Led a team of four on the billing platform.

## Education

Bachelor of Science, Computer Science, University of Washington, 2018

## Skills

Python, PostgreSQL, Docker`

    const report = checkReformatFaithfulness(SOURCE_RESUME, faithful)
    expect(report.invented).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('treats an OCR word-rejoin as a repair, not an invention', () => {
    // "Post greSQL" split across a line break is the commonest extraction
    // artifact; despacing the source is what keeps this from being a false hit.
    const source = SOURCE_RESUME.replace('PostgreSQL', 'Post greSQL')
    const report = checkReformatFaithfulness(source, `## Skills\n\nPython, PostgreSQL, Docker`)
    expect(report.invented).toEqual([])
  })

  it('refuses a fabrication even in a resume too short for the ratios', () => {
    // Short documents are where ratios are weakest, so containment must run
    // before the MIN_TOKENS_TO_JUDGE early return rather than after it.
    const report = checkReformatFaithfulness('Jane Okafor\nEngineer at Globex', '# Jane Okafor\n\nEngineer at Google')
    expect(report.ok).toBe(false)
    expect(report.invented).toContain('Google')
  })
})
