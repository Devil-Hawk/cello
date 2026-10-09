import { describe, expect, it } from 'vitest'
import { unbackedTokens } from './backing'

const headline = 'Linear raises $35M Series B led by Accel'

describe('unbackedTokens', () => {
  it('compares numbers by value, whatever the spelling', () => {
    expect(unbackedTokens('A headline reports a $35M Series B led by Accel.', headline, ['Linear'])).toEqual([])
    expect(unbackedTokens('It raised 35 million dollars.', headline, ['Linear'])).toEqual([])
    expect(unbackedTokens('It raised $50M.', headline, ['Linear'])).toEqual(['$50M'])
    expect(unbackedTokens('Headcount is 1,200 people.', 'We are 1200 people worldwide.')).toEqual([])
  })

  it('flags a named investor or place the excerpts never mention', () => {
    expect(unbackedTokens('The round was led by Sequoia.', headline, ['Linear'])).toEqual(['Sequoia'])
    expect(unbackedTokens('It has an office in Berlin.', 'We are remote-first.', ['Linear'])).toEqual(['Berlin'])
  })

  it('does not flag the first word of a sentence, the company name, or a Wikipedia attribution', () => {
    expect(unbackedTokens('Linear makes a tool for planning products.', 'A purpose-built tool for planning products.', ['Linear'])).toEqual([])
    expect(unbackedTokens('Remote-first teams ship faster. Hiring is open.', 'Remote-first. Hiring is open.')).toEqual([])
    expect(unbackedTokens('Wikipedia describes Acme Corp as a maker of anvils.', 'Acme Corp is a maker of anvils.', ['Acme Corp'])).toEqual([])
  })

  it('accepts a paraphrase with no new names or numbers', () => {
    expect(unbackedTokens('It is hiring engineers who work in TypeScript and React.', 'We are hiring engineers. We build with TypeScript and React.')).toEqual([])
  })

  it('compares names by spelling, not by case', () => {
    expect(unbackedTokens('It builds on Postgres.', 'We run postgres in production.')).toEqual([])
  })
})
