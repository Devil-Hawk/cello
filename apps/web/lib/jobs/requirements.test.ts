import { describe, expect, it, vi } from 'vitest'
import {
  RequirementsSchema,
  groundModelAnswer,
  needsModel,
  parseRequirements,
  parseSalary,
  parseVisa,
  parseYears,
  splitSections,
} from './requirements'
import { findSkills } from './skill-vocabulary'
import { completeRequirements } from './requirements-model'
import { MODEL_LIMIT } from '../ingest/model'

const DATA_ENGINEER = `About the team
We build the analytics platform that every product team at Acme relies on.

What you'll do
* Build and run batch and streaming pipelines
* Partner with analysts on data modeling

Minimum requirements
* 5+ years of experience in data engineering
* Strong SQL and Python
* Have run Airflow in production

Preferred requirements
* Experience with dbt or Snowflake
* Familiarity with Terraform

Pay Range
$150,000 - $190,000 USD

We do not offer visa sponsorship for this role.`

describe('splitSections', () => {
  it('puts bullets under their heading and ignores the rest of the posting', () => {
    const s = splitSections(DATA_ENGINEER)
    expect(s.found).toBe(true)
    expect(s.must).toContain('Airflow')
    expect(s.must).not.toContain('batch and streaming')
    expect(s.nice).toContain('dbt')
    expect(s.nice).not.toContain('Airflow')
  })

  it('reports no section when the posting never says what it asks for', () => {
    expect(splitSections('Acme builds tools for restaurants.\nJoin a fast-growing team.').found).toBe(false)
  })

  it('reads an inline "Nice to have:" bullet as nice to have', () => {
    const s = splitSections('Requirements\n- Python\n- Nice to have: Rust')
    expect(s.must).toContain('Python')
    expect(s.nice).toContain('Rust')
  })
})

describe('findSkills', () => {
  it('matches whole tokens only', () => {
    expect(findSkills('We use JavaScript and TypeScript')).toEqual(['JavaScript', 'TypeScript'])
    expect(findSkills('Strong Java skills')).toEqual(['Java'])
  })

  it('does not read ordinary words as skills', () => {
    expect(findSkills('Go to market with a good plan, the rest is up to you. Spark joy.')).toEqual([])
    expect(findSkills('Python, Go, Rust')).toEqual(['Python', 'Go', 'Rust'])
    expect(findSkills('Experience with Golang')).toEqual(['Go'])
  })

  it('keeps symbols in names', () => {
    expect(findSkills('C++, C# and .NET')).toEqual(['C++', 'C#', '.NET'])
  })
})

describe('parseYears', () => {
  it('takes the largest experience figure in the requirements', () => {
    expect(parseYears('5+ years of experience in engineering, 2+ years of experience with Kubernetes')).toEqual({ min: 5, max: null })
  })
  it('reads a range', () => {
    expect(parseYears('3-5 years of relevant experience')).toEqual({ min: 3, max: 5 })
  })
  it('ignores a company age', () => {
    expect(parseYears('Founded 12 years ago, we have been around for over 12 years.')).toEqual({ min: null, max: null })
  })
})

describe('parseVisa', () => {
  it('quotes a refusal', () => {
    const v = parseVisa('Great team. We do not offer visa sponsorship for this role. Apply today.')
    expect(v.sponsorship).toBe('not_offered')
    expect(v.evidence).toBe('We do not offer visa sponsorship for this role.')
  })
  it('a refusal outranks the words "visa sponsorship" inside it', () => {
    expect(parseVisa('Visa sponsorship is not available.').sponsorship).toBe('not_offered')
  })
  it('quotes an offer', () => {
    expect(parseVisa('We offer visa sponsorship and relocation support.').sponsorship).toBe('offered')
  })
  it('says not stated when the posting is silent', () => {
    expect(parseVisa('A role about sponsors of events.')).toEqual({ sponsorship: 'not_stated', evidence: null })
  })
})

describe('parseSalary', () => {
  it('reads the provider string first', () => {
    expect(parseSalary('USD 128,000–180,000 / yr', '')).toEqual({ min: 128000, max: 180000, currency: 'USD', period: 'year' })
  })
  it('reads a range near pay words in the posting', () => {
    expect(parseSalary(null, 'Pay Range\n$150,000 - $190,000 USD')).toMatchObject({ min: 150000, max: 190000, currency: 'USD' })
  })
  it('reads k suffixes', () => {
    expect(parseSalary(null, 'Salary: $85k-$100k per year')).toMatchObject({ min: 85000, max: 100000, period: 'year' })
  })
  it('reads hourly pay', () => {
    expect(parseSalary('USD 40–55 per hour', '')).toMatchObject({ min: 40, max: 55, period: 'hour' })
  })
  it('does not take a funding round for pay', () => {
    expect(parseSalary(null, 'We raised $50 million - $100 million from investors last year.')).toBeNull()
  })
})

describe('parseRequirements', () => {
  const req = parseRequirements({
    title: 'Senior Data Engineer',
    description: DATA_ENGINEER,
    location: 'Remote (US)',
    salaryRange: null,
  })

  it('splits must-have from nice-to-have', () => {
    expect(req.must_have).toEqual(expect.arrayContaining(['SQL', 'Python', 'Airflow']))
    expect(req.nice_to_have).toEqual(expect.arrayContaining(['dbt', 'Snowflake', 'Terraform']))
    expect(req.must_have).not.toContain('dbt')
    expect(req.skills_resolved).toBe(true)
  })

  it('reads years, seniority, location, visa and salary', () => {
    expect(req.years_experience.min).toBe(5)
    expect(req.seniority).toBe('senior')
    expect(req.location).toEqual({ mode: 'remote', places: ['Remote (US)'] })
    expect(req.visa.sponsorship).toBe('not_offered')
    expect(req.salary).toMatchObject({ min: 150000, max: 190000, currency: 'USD' })
  })

  it('always satisfies the schema', () => {
    expect(RequirementsSchema.safeParse(req).success).toBe(true)
    expect(RequirementsSchema.safeParse(parseRequirements({ title: 'x', description: '' })).success).toBe(true)
  })

  it('leaves the lists empty and unresolved when the posting has no requirements section', () => {
    const thin = parseRequirements({ title: 'Account Executive', description: 'Acme sells to restaurants. '.repeat(30) })
    expect(thin.skills_resolved).toBe(false)
    expect(thin.must_have).toEqual([])
    expect(needsModel(thin, 'Acme sells to restaurants. '.repeat(30))).toBe(true)
  })

  it('does not ask a model about a posting that is too short to hold requirements', () => {
    expect(needsModel(parseRequirements({ title: 'x', description: 'Short.' }), 'Short.')).toBe(false)
  })
})

describe('groundModelAnswer', () => {
  const description = 'Own a $1.2M quota selling to mid-market finance teams. Minimum 3 years closing B2B SaaS deals; comfortable with Salesforce. Bonus: fintech background. '.repeat(3)
  const base = parseRequirements({ title: 'Account Executive', description })

  it('keeps what the posting says and drops what it does not', () => {
    const out = groundModelAnswer(base, description, {
      must_have: ['closing B2B SaaS deals', 'Salesforce', 'Kubernetes'],
      nice_to_have: ['fintech background', 'MBA'],
      years_min: 3,
    })
    expect(out.must_have).toEqual(['closing B2B SaaS deals', 'Salesforce'])
    expect(out.nice_to_have).toEqual(['fintech background'])
    expect(out.years_experience.min).toBe(3)
    expect(out.source).toBe('mixed')
    expect(out.skills_resolved).toBe(true)
  })

  it('drops a years figure the posting never wrote', () => {
    const noYears = 'Own a quota selling to finance teams. Comfortable with Salesforce. '.repeat(8)
    const bare = parseRequirements({ title: 'Account Executive', description: noYears })
    const out = groundModelAnswer(bare, noYears, { must_have: ['Salesforce'], nice_to_have: [], years_min: 8 })
    expect(out.years_experience.min).toBeNull()
  })

  it('returns the deterministic result when nothing survives', () => {
    const out = groundModelAnswer(base, description, { must_have: ['Kubernetes'], nice_to_have: ['Terraform'], years_min: null })
    expect(out).toBe(base)
  })
})

describe('completeRequirements', () => {
  const description = 'Own a quota selling to mid-market finance teams. Minimum 3 years closing B2B SaaS deals; comfortable with Salesforce. '.repeat(5)
  const input = { title: 'Account Executive', description }
  const base = parseRequirements(input)

  it('asks the model only when the posting could not be split', async () => {
    const call = vi.fn().mockResolvedValue('{"must_have":["Salesforce"],"nice_to_have":[],"years_min":3}')
    const out = await completeRequirements(base, input, call)
    expect(call).toHaveBeenCalledTimes(1)
    expect(out.must_have).toEqual(['Salesforce'])

    const resolved = parseRequirements({ title: 'Data Engineer', description: DATA_ENGINEER })
    call.mockClear()
    expect(await completeRequirements(resolved, { title: 'x', description: DATA_ENGINEER }, call)).toBe(resolved)
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the deterministic result when the model fails, answers nonsense, or invents', async () => {
    expect(await completeRequirements(base, input, async () => null)).toBe(base)
    expect(await completeRequirements(base, input, async () => MODEL_LIMIT)).toBe(base)
    expect(await completeRequirements(base, input, async () => { throw new Error('429') })).toBe(base)
    for (const answer of ['not json', '{"must_have":["Kubernetes"]}']) {
      const out = await completeRequirements(base, input, async () => answer)
      expect({ ...out, model_checked_at: undefined }).toEqual({ ...base, model_checked_at: undefined })
    }
  })

  it('stamps a posting a model read, even when it found nothing, and not one it never reached', async () => {
    const at = new Date('2026-10-06T00:00:00Z')
    const refused = await completeRequirements(base, input, async () => '{"must_have":[],"nice_to_have":[]}', () => at)
    expect(refused.model_checked_at).toBe(at.toISOString())
    expect(refused.skills_resolved).toBe(false)
    expect((await completeRequirements(base, input, async () => 'not json', () => at)).model_checked_at).toBe(at.toISOString())
    expect((await completeRequirements(base, input, async () => null, () => at)).model_checked_at).toBeUndefined()
    expect((await completeRequirements(base, input, async () => MODEL_LIMIT, () => at)).model_checked_at).toBeUndefined()
  })

  it('drops an item longer than six words even if the posting says it', () => {
    const text = 'You will have experience with the full end to end lifecycle of enterprise sales cycles'
    const out = groundModelAnswer(base, text, { must_have: ['the full end to end lifecycle of enterprise sales cycles', 'enterprise sales cycles'], nice_to_have: [], years_min: null })
    expect(out.must_have).toEqual(['enterprise sales cycles'])
  })

  it('puts the posting in tags and the free-model rule on the call', async () => {
    const call = vi.fn().mockResolvedValue('{"must_have":[],"nice_to_have":[]}')
    await completeRequirements(base, input, call)
    const req = call.mock.calls[0][0]
    expect(req.prompt).toContain('BEGIN UNTRUSTED JOB POSTING')
    expect(req.system).toContain('Job requirements reader')
    expect(req.name).toBe('read-job-requirements')
  })
})

const MARKDOWN = `## About the team

We build the analytics platform that every product team at Acme relies on.

## Minimum requirements

-   5+ years of experience in data engineering
-   Strong SQL and Python
-   Have run Airflow in production
-   Bachelor's degree in a technical field
-   Active security clearance

## Preferred requirements

-   Experience with dbt or Snowflake
-   Nice to have: Terraform

## Pay Range

$150,000 - $190,000 USD
`

describe('requirements version 2: the items', () => {
  const items = parseRequirements({ title: 'Data Engineer', description: DATA_ENGINEER, descriptionMd: MARKDOWN }).items ?? []

  it('is version 2, and the version 1 keys are what version 1 read from the same text', () => {
    const v2 = parseRequirements({ title: 'Data Engineer', description: DATA_ENGINEER, descriptionMd: MARKDOWN })
    expect(v2.version).toBe(2)
    expect(RequirementsSchema.safeParse(v2).success).toBe(true)
    const plain = parseRequirements({ title: 'Data Engineer', description: DATA_ENGINEER })
    const { items: _a, ...v1keys } = v2
    const { items: _b, ...v1plain } = plain
    expect(v1keys).toEqual(v1plain)
    expect(v1keys.must_have).toContain('Airflow')
    expect(v1keys.years_experience).toEqual({ min: 5, max: null })
  })

  it('reads one item for each bullet under a requirements heading, with its kind and heading', () => {
    expect(items.map((i) => [i.kind, i.heading, i.text])).toEqual([
      ['must', 'Minimum requirements', '5+ years of experience in data engineering'],
      ['must', 'Minimum requirements', 'Strong SQL and Python'],
      ['must', 'Minimum requirements', 'Have run Airflow in production'],
      ['must', 'Minimum requirements', "Bachelor's degree in a technical field"],
      ['must', 'Minimum requirements', 'Active security clearance'],
      ['nice', 'Preferred requirements', 'Experience with dbt or Snowflake'],
      ['nice', 'Preferred requirements', 'Nice to have: Terraform'],
    ])
    // the pay section is not a requirement
    expect(items.some((i) => i.text.includes('150,000'))).toBe(false)
  })

  it('has every quote verbatim in the Markdown, and every item read by code', () => {
    for (const i of items) {
      expect(MARKDOWN, i.text).toContain(i.quote)
      expect(i.origin).toBe('code')
      expect(i.prov.rule).toBeTruthy()
    }
  })

  it('reads skills, years, degree and clearance of each item by code', () => {
    const by = (text: string) => items.find((i) => i.text.startsWith(text))!
    expect(by('5+ years').years).toEqual({ min: 5, max: null })
    expect(by('Strong SQL').skills).toEqual(expect.arrayContaining(['SQL', 'Python']))
    expect(by("Bachelor's").degree?.toLowerCase()).toContain('bachelor')
    expect(by('Active security').clearance?.toLowerCase()).toBe('security clearance')
    expect(by('Have run').years).toBeNull()
  })

  it('gives an item an id that stays when the posting is edited elsewhere', () => {
    const edited = MARKDOWN.replace('We build the analytics platform', 'We build the whole analytics platform')
    const again = parseRequirements({ title: 'Data Engineer', description: DATA_ENGINEER, descriptionMd: edited }).items ?? []
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id))
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  it('reads a plain-text posting the same way, headings without markers', () => {
    const plain = parseRequirements({ title: 'Data Engineer', description: DATA_ENGINEER }).items ?? []
    expect(plain.filter((i) => i.kind === 'must').map((i) => i.text)).toEqual(['5+ years of experience in data engineering', 'Strong SQL and Python', 'Have run Airflow in production'])
    for (const i of plain) expect(DATA_ENGINEER).toContain(i.quote)
  })

  it('reads the sentences of a paragraph under a requirements heading', () => {
    const md = '## Requirements\n\nYou know Go well. You have shipped a service to production.\n\n## Perks\n\n- Free lunch'
    const read = parseRequirements({ title: 'Engineer', description: md, descriptionMd: md }).items ?? []
    expect(read.map((i) => i.text)).toEqual(['You know Go well.', 'You have shipped a service to production.'])
  })

  it('finds no items in a posting that never says what it asks for', () => {
    expect(parseRequirements({ title: 'Cook', description: 'Join our kitchen team.\nWe love food.' }).items).toEqual([])
  })
})

describe('a model\'s item needs the posting\'s own words', () => {
  const base = parseRequirements({ title: 'Engineer', description: 'We build things.', descriptionMd: 'We build things.' })

  it('is kept with the line that says it, verbatim in the Markdown, and marked as a model\'s', () => {
    const md = 'We use Kubernetes and Terraform every day.\n\nYou will own our deploys.'
    const out = groundModelAnswer(base, md, { must_have: ['Kubernetes'], nice_to_have: [] }, { descriptionMd: md, at: '2026-10-08T00:00:00Z' })
    const item = out.items?.find((i) => i.text === 'Kubernetes')
    expect(item).toMatchObject({ origin: 'model', kind: 'must', quote: 'We use Kubernetes and Terraform every day.', prov: { step: 'read-job-requirements', at: '2026-10-08T00:00:00Z' } })
    expect(md).toContain(item!.quote)
  })

  it('is dropped when the skill is not in the Markdown, even if the plain copy has it', () => {
    const out = groundModelAnswer(base, 'We use Kubernetes.', { must_have: ['Kubernetes'], nice_to_have: [] }, { descriptionMd: 'Something else entirely.' })
    expect(out.items ?? []).toEqual([])
    // nothing grounded in the plain copy either way: the skill list follows the plain copy as before
    expect(out.must_have).toEqual(['Kubernetes'])
  })
})
