// PeopleGraph renders the contacts surface as an SVG force-directed graph
// (see the module comment in people-graph.tsx for why contact->contact
// "introduced" edges are deliberately absent). Like ranked-contacts.test.tsx,
// this uses renderToStaticMarkup — no jsdom is configured, and the component
// holds no state that a static render can't exercise: click handlers never
// fire in SSR markup, but node/edge counts and positions are baked into the
// output as SVG attributes.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { PeopleGraph } from './people-graph'
import type { Contact, ContactCompany } from './types'

function company(id: string, name: string): ContactCompany {
  return { id, name, logo_url: null }
}

function contact(over: Partial<Contact> & { id: string; name: string }): Contact {
  return {
    user_id: 'user-1',
    company_id: null,
    email: null,
    linkedin_url: null,
    title: null,
    relationship: null,
    last_contact_at: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    companies: null,
    ...over,
  }
}

const ACME = company('acme', 'Acme Corp')
const GLOBEX = company('globex', 'Globex Inc')
const INITECH = company('initech', 'Initech')

// 8 contacts: 3 at Acme, 2 at Globex, 2 at Initech, 1 with no company at all.
const CONTACTS: Contact[] = [
  contact({ id: '1', name: 'Dana Chief', company_id: 'acme', companies: ACME, relationship: 'colleague' }),
  contact({ id: '2', name: 'Sam Sourcer', company_id: 'acme', companies: ACME, relationship: 'recruiter' }),
  contact({ id: '3', name: 'Ines Ic', company_id: 'acme', companies: ACME }),
  contact({ id: '4', name: 'Gabe Globex', company_id: 'globex', companies: GLOBEX, relationship: 'alumni' }),
  contact({ id: '5', name: 'Gina Globex', company_id: 'globex', companies: GLOBEX }),
  contact({ id: '6', name: 'Ivan Initech', company_id: 'initech', companies: INITECH, relationship: 'friend' }),
  contact({ id: '7', name: 'Iris Initech', company_id: 'initech', companies: INITECH }),
  contact({ id: '8', name: 'No Company Nora', relationship: 'linkedin_connection' }),
]

function render(contacts: Contact[]): string {
  return renderToStaticMarkup(createElement(PeopleGraph, { contacts, onSelectContact: () => {} }))
}

describe('PeopleGraph — node and edge counts', () => {
  it('draws one node for You, one per company, and one per contact', () => {
    const html = render(CONTACTS)
    // 1 you + 3 companies + 8 contacts = 12 nodes, each a <circle>.
    expect(html.match(/<circle/g)?.length).toBe(12)
  })

  it('draws a you->contact edge for everyone, plus a contact->company edge for the ones with a company', () => {
    const html = render(CONTACTS)
    // 8 you->contact edges + 7 contact->company edges (Nora has none) = 15.
    expect(html.match(/<line/g)?.length).toBe(15)
  })

  it('still renders a contact with no company, attached to You only', () => {
    const html = render(CONTACTS)
    expect(html).toContain('No Company')
  })

  it('renders all three company names', () => {
    const html = render(CONTACTS)
    expect(html).toContain('Acme Corp')
    expect(html).toContain('Globex Inc')
    expect(html).toContain('Initech')
  })
})

describe('PeopleGraph — thin states', () => {
  it('lays out a single contact with no company deliberately, not as a lonely dot', () => {
    const html = render([contact({ id: 'solo', name: 'Solo Person' })])
    // you + the one contact = 2 nodes, 1 edge, and it's still a real layout.
    expect(html.match(/<circle/g)?.length).toBe(2)
    expect(html.match(/<line/g)?.length).toBe(1)
    expect(html).toContain('Solo Person')
  })
})

describe('PeopleGraph — determinism', () => {
  it('lays out the same contacts identically on every render', () => {
    const first = render(CONTACTS)
    const second = render(CONTACTS)
    expect(first).toBe(second)
  })
})
