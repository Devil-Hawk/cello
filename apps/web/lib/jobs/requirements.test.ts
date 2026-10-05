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
    expect(await completeRequirements(base, input, async () => 'not json')).toBe(base)
    expect(await completeRequirements(base, input, async () => { throw new Error('429') })).toBe(base)
    expect(await completeRequirements(base, input, async () => '{"must_have":["Kubernetes"]}')).toBe(base)
  })

  it('puts the posting in tags and the free-model rule on the call', async () => {
    const call = vi.fn().mockResolvedValue('{"must_have":[],"nice_to_have":[]}')
    await completeRequirements(base, input, call)
    const req = call.mock.calls[0][0]
    expect(req.prompt).toContain('<posting>')
    expect(req.system).toContain('Job requirements reader')
    expect(req.name).toBe('read-job-requirements')
  })
})
