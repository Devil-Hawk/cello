import { describe, expect, it } from 'vitest'
import { loadModeDoc, promptRef } from '../harness/prompts'
import { ModelAnswerSchema, groundModelAnswer, parseRequirements } from '../jobs/requirements'

describe('ingestion prompts', () => {
  for (const name of ['page_reader', 'requirements']) {
    it(`${name} resolves, is hashed for tracing and has no em dash`, () => {
      const doc = loadModeDoc(name)
      expect(doc.length).toBeGreaterThan(500)
      expect(promptRef(name).hash).toMatch(/^[0-9a-f]{8}$/)
      expect(doc).not.toContain('—')
    })
  }

  it('every example in the requirements prompt survives the grounding the code applies to an answer', () => {
    const doc = loadModeDoc('requirements')
    const fence = '`'.repeat(3)
    const pattern = new RegExp(`Posting[^:]*: "([^"]+)"\\s+${fence}\\n(\\{[^\\n]+\\})\\n${fence}`, 'g')
    const examples = [...doc.matchAll(pattern)]
    expect(examples.length).toBe(3)
    for (const [, posting, json] of examples) {
      const answer = ModelAnswerSchema.parse(JSON.parse(json))
      const named = answer.must_have.length + answer.nice_to_have.length
      if (named === 0) continue
      const grounded = groundModelAnswer(parseRequirements({ title: 'Role', description: posting }), posting, answer)
      expect(grounded.must_have.length + grounded.nice_to_have.length, posting).toBe(named)
      if (answer.years_min) expect(grounded.years_experience.min).toBe(answer.years_min)
    }
  })

  it('the page reader prompt names every page kind the code accepts', () => {
    const doc = loadModeDoc('page_reader')
    for (const kind of ['listing', 'single_posting', 'no_postings', 'not_a_jobs_page']) expect(doc).toContain(kind)
  })
})
