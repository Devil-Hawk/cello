import { describe, expect, it } from 'vitest'
import { AskUserError, formatAskAnswers, parseAskUserRequest } from './ask-user'

const ok = {
  questions: [
    {
      header: 'Roles',
      question: 'Which kinds of role should Cello pursue?',
      multiSelect: true,
      options: [
        { label: 'Backend', description: 'Services, APIs, data pipelines' },
        { label: 'Infrastructure', description: 'Platform, SRE, developer tooling' },
      ],
    },
  ],
}

describe('parseAskUserRequest', () => {
  it('accepts a well-formed question', () => {
    const parsed = parseAskUserRequest(ok)
    expect(parsed.questions[0].options).toHaveLength(2)
    expect(parsed.questions[0].multiSelect).toBe(true)
  })

  it('defaults multiSelect to false rather than guessing', () => {
    const { questions } = parseAskUserRequest({
      questions: [{ ...ok.questions[0], multiSelect: undefined }],
    })
    expect(questions[0].multiSelect).toBe(false)
  })

  it('rejects a single-option question, which is not a choice', () => {
    expect(() =>
      parseAskUserRequest({ questions: [{ ...ok.questions[0], options: [{ label: 'Backend' }] }] })
    ).toThrow(AskUserError)
  })

  it('rejects duplicate headers, which would overwrite each other in the answers', () => {
    expect(() => parseAskUserRequest({ questions: [ok.questions[0], ok.questions[0]] })).toThrow(
      /unique/i
    )
  })

  it('rejects an interrogation', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...ok.questions[0],
      header: `Q${i}`,
    }))
    expect(() => parseAskUserRequest({ questions: many })).toThrow(/at most/i)
  })

  it('rejects a header too long for its chip', () => {
    expect(() =>
      parseAskUserRequest({
        questions: [{ ...ok.questions[0], header: 'An extremely long header' }],
      })
    ).toThrow(/chip/i)
  })

  it('drops blank options rather than rendering an empty button', () => {
    expect(() =>
      parseAskUserRequest({
        questions: [{ ...ok.questions[0], options: [{ label: 'Backend' }, { label: '   ' }] }],
      })
    ).toThrow(/at least/i)
  })

  it('gives the model an actionable message, not a bare failure', () => {
    try {
      parseAskUserRequest({ questions: [] })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toMatch(/non-empty/i)
    }
  })
})

describe('formatAskAnswers', () => {
  it('renders selections as prose for the model', () => {
    expect(formatAskAnswers([{ header: 'Roles', selected: ['Backend', 'Infrastructure'] }])).toBe(
      'Roles: Backend, Infrastructure'
    )
  })

  it('keeps a typed note verbatim', () => {
    expect(
      formatAskAnswers([{ header: 'Roles', selected: ['Backend'], note: 'no on-call please' }])
    ).toMatch(/note: no on-call please/)
  })

  it('distinguishes a skipped question from an unseen one', () => {
    expect(formatAskAnswers([{ header: 'Roles', selected: [] }])).toMatch(/skipped/)
    expect(formatAskAnswers([])).toMatch(/dismissed/i)
  })
})
