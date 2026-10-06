import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Landing } from './landing'
import { REFUSALS, FAQ } from './content'

const html = renderToStaticMarkup(<Landing />)
const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('Landing', () => {
  it('leads with the promise and one Get started', () => {
    expect(text).toContain('Roles that actually fit you, for people tired of applying into silence.')
    expect(html.match(/Get started/g)).toHaveLength(1)
    expect(text).toContain('Have a demo code?')
  })

  it('claims no counts, percentages or hourly checks', () => {
    // Only the example frame, labelled made up, and "every 6 hours" carry digits.
    const claims = text.replace(/every 6 hours/g, '').replace(/^.*Example\. These companies are made up\./, '')
    expect(text).not.toMatch(/%|hourly|every hour|users|customers/i)
    expect(claims.match(/\d/g) ?? []).toHaveLength(1) // the example's "2 things need you."
  })

  it('labels the example as made up', () => {
    expect(text).toContain('Example. These companies are made up.')
  })

  it('holds the six refusals and the FAQ, with their sentences on request', () => {
    expect(REFUSALS).toHaveLength(6)
    for (const r of REFUSALS) expect(html).toContain(r.heading)
    expect((html.match(/<details/g) ?? []).length).toBe(REFUSALS.length + FAQ.length)
    expect(text).toContain('Sending an application needs a computer.')
  })

  it('uses no em dash, exclamation mark or retired word', () => {
    expect(text).not.toMatch(/—|!|receipt|AI-powered|copilot|dashboard/i)
  })
})
