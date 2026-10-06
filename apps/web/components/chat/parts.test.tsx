import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Card, CompanyCard, RoleCard } from '@/lib/chat/cards'
import type { Part } from '@/lib/chat/types'
import { AnswerParts, type Named } from './parts'
import { NAME_CLASS, RoleCard as RoleCardView } from './cards/role-card'
import { CompanyCard as CompanyCardView } from './cards/company-card'

const role: RoleCard = { kind: 'role', id: 'r1', title: 'Senior Backend Engineer, Payments', company: 'Vantage Loom', companyId: 'c1', logoUrl: null, place: 'New York, NY (Hybrid)', chance: 'strong', pay: '$190,000 - $230,000', state: 'applied' }
const company: CompanyCard = { kind: 'company', id: 'c1', name: 'Vantage Loom', logoUrl: null, domain: 'vantage.example.com', openCount: 3, keptCount: 1, following: true }
const names: Named[] = [
  { kind: 'role', ref: 'r1', name: 'Payments role' },
  { kind: 'company', ref: 'c1', name: 'Vantage Loom' },
]
const html = (parts: Part[], over: { tileCount?: number; cards?: Card[] } = {}) => renderToStaticMarkup(<AnswerParts parts={parts} names={names} tileCount={over.tileCount ?? 2} cards={over.cards ?? [role, company]} />)

describe('role card', () => {
  it('shows only what the stored row holds, with the title and the company at the same weight', () => {
    const out = renderToStaticMarkup(<RoleCardView card={role} />)
    expect(out).toContain('Senior Backend Engineer, Payments')
    expect(out).toContain('Pay as stated: $190,000 - $230,000')
    expect(out).toContain('Chance: Strong')
    expect(out).toContain('New York, NY (Hybrid)')
    expect(out).toContain('Applied')
    expect(out).toContain('href="/roles/r1"')
    // The title and the company carry the same classes.
    expect((out.match(new RegExp(`<p class="${NAME_CLASS} break-words">`, 'g')) ?? []).length).toBe(2)
  })

  it('leaves out pay, chance, place and state it does not have', () => {
    const out = renderToStaticMarkup(<RoleCardView card={{ ...role, pay: null, chance: null, place: null, state: null }} />)
    expect(out).not.toContain('Pay as stated')
    expect(out).not.toContain('Chance')
    expect(out).not.toContain(' · ')
  })
})

describe('company card', () => {
  it('shows its counts and following state from the row', () => {
    const out = renderToStaticMarkup(<CompanyCardView card={company} />)
    expect(out).toContain('3 open · 1 application · Following')
    expect(out).toContain('href="/companies/c1"')
    expect(renderToStaticMarkup(<CompanyCardView card={{ ...company, following: false, keptCount: 2 }} />)).toContain('3 open · 2 applications')
  })
})

describe('AnswerParts', () => {
  const parts: Part[] = [
    { card: { kind: 'role', ref: 'r1' } },
    { about: [{ kind: 'role', ref: 'r1' }], text: 'It states **pay** of $190,000. See [Vantage](cello:company/c1).' },
    { about: [], text: 'A line about nothing in particular.' },
  ]

  it('leads a part with the things it is about when the chat holds several tiles, and not for one', () => {
    const several = html(parts)
    expect(several).toContain('data-lead')
    expect(several).toContain('Payments role')
    expect(html(parts, { tileCount: 1 })).not.toContain('data-lead')
    // A part about nothing has no lead even with several tiles.
    expect((several.match(/data-lead/g) ?? []).length).toBe(1)
  })

  it('draws one card for the subject, from the stored row, and none when the row could not be read', () => {
    const twice: Part[] = [{ card: { kind: 'role', ref: 'r1' } }, { card: { kind: 'role', ref: 'r1' } }]
    expect((html(twice).match(/data-card="role"/g) ?? []).length).toBe(1)
    expect(html(parts, { cards: [] })).not.toContain('data-card')
    expect(html([{ card: { kind: 'company', ref: 'c1' } }])).toContain('data-card="company"')
  })

  it('renders the text as Markdown with the cello link turned into the page link, and no raw HTML', () => {
    const out = html([{ about: [], text: 'See [Vantage](cello:company/c1) and [a draft](cello:made/m1).\n\n<script>alert(1)</script>\n\n| a | b |\n| - | - |\n| 1 | 2 |' }])
    expect(out).toContain('<a href="/companies/c1"')
    expect(out).toContain('a draft')
    expect(out).not.toContain('cello:')
    expect(out).not.toContain('<script')
    expect(out).toContain('<table')
  })

  it('has Copy on each text part, and says "No longer listed" for a thing it has no name for', () => {
    const out = html([{ about: [{ kind: 'role', ref: 'gone' }], text: 'Text.' }])
    expect(out).toContain('aria-label="Copy"')
    expect(out).toContain('No longer listed')
  })

  it('renders a long answer with headings, tables and Copy', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of a very long answer.`).join(' ')
    const out = html([{ about: [], text: `## Heading\n\n${long}\n\n| a | b |\n| - | - |\n| 1 | 2 |` }])
    // The product's Markdown draws a heading as a bold paragraph of its own.
    expect(out).toContain('>Heading</p>')
    expect(out).toContain('<table')
    expect(out).toContain('aria-label="Copy"')
  })
})
