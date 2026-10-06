import { describe, expect, it } from 'vitest'
import { chatHref, rewriteCelloLinks } from './links'

describe('chatHref', () => {
  it('gives each kind its page and leaves made things and material to the side panel', () => {
    expect(chatHref('role', 'r 1')).toBe('/jobs?job=r%201')
    expect(chatHref('company', 'c1')).toBe('/companies/c1')
    expect(chatHref('chat', 'x1')).toBe('/chat/x1')
    expect(chatHref('made', 'm1')).toBeNull()
    expect(chatHref('material', 'm1')).toBeNull()
  })
})

describe('rewriteCelloLinks', () => {
  it('turns a cello link into the page link and keeps the label of a thing with no page', () => {
    const text = 'See [Ramp](cello:company/c1), [the draft](cello:made/m1) and [a role](cello:role/r1).'
    expect(rewriteCelloLinks(text)).toBe('See [Ramp](/companies/c1), the draft and [a role](/jobs?job=r1).')
  })

  it('leaves ordinary links alone and cannot be made to link elsewhere', () => {
    expect(rewriteCelloLinks('[site](https://example.com)')).toBe('[site](https://example.com)')
    expect(rewriteCelloLinks('[x](cello:role/../admin)')).toBe('[x](/jobs?job=..%2Fadmin)')
    expect(rewriteCelloLinks('[x](cello:unknown/1)')).toBe('x')
  })
})
