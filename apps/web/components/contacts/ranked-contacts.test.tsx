// The claim this component exists to make visible: the SAME sourced list is
// ordered differently depending on how big the company is, and every row says
// why. These tests pin the rendered output, not just the scoring — a correct
// ranking that renders in source order would be the original bug wearing a
// lib/ module.
//
// renderToStaticMarkup rather than a DOM renderer: no jsdom environment is
// configured in vitest.config.ts, and RankedContactList holds no state and
// touches no browser API — same approach as
// components/copilot/observation-view.test.tsx.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { RankedContactList, type RankableContact } from './ranked-contacts'
import type { RoleContext } from '@/lib/contacts/relevance'

function contact(over: Partial<RankableContact> & { id: string; name: string }): RankableContact {
  return { email: null, title: null, relationship: null, ...over }
}

// One sourcing run's worth of people, in the order a scraper finds them:
// the exec first, because that is who a company puts on its own pages.
const SOURCED: RankableContact[] = [
  contact({ id: '1', name: 'Dana Chief', title: 'Chief Executive Officer', email: 'dana@acme.com' }),
  contact({ id: '2', name: 'Sam Sourcer', title: 'Technical Recruiter', email: 'sam@acme.com' }),
  contact({ id: '3', name: 'Ines Ic', title: 'Senior Backend Engineer' }),
  contact({ id: '4', name: 'Sal Sales', title: 'Director of Sales' }),
]

const BIGCO: RoleContext = { jobFunction: 'engineering', jobTitle: 'Senior Backend Engineer', openRoleCount: 240 }
const STARTUP: RoleContext = { jobFunction: 'engineering', jobTitle: 'Senior Backend Engineer', openRoleCount: 4 }

function render(contacts: RankableContact[], role: RoleContext): string {
  return renderToStaticMarkup(createElement(RankedContactList, { contacts, role }))
}

describe('RankedContactList — company size reorders the same people', () => {
  it('buries a big company CEO below the recruiter, the manager-adjacent IC and everyone else', () => {
    const html = render(SOURCED, BIGCO)
    expect(html.indexOf('Sam Sourcer')).toBeLessThan(html.indexOf('Ines Ic'))
    expect(html.indexOf('Ines Ic')).toBeLessThan(html.indexOf('Dana Chief'))
    expect(html).toContain('Owns roles like this one')
    expect(html).toContain('Unlikely to move this application')
  })

  it('leads with the SAME founder at a startup', () => {
    const html = render([SOURCED[0], SOURCED[2]], STARTUP)
    expect(html.indexOf('Dana Chief')).toBeLessThan(html.indexOf('Ines Ic'))
    expect(html).toContain('Small enough to hire directly')
  })
})

describe('RankedContactList — the ranking explains itself', () => {
  it('prints a reason on every row', () => {
    const html = render(SOURCED, BIGCO)
    expect(html).toContain('recruiting or people team')
    expect(html).toContain('well placed to refer you')
    expect(html).toContain('a cold note will not reach them')
    expect(html).toContain('different function')
  })

  it('names the size proxy in the reason, so the ordering is checkable', () => {
    expect(render([SOURCED[0]], BIGCO)).toContain('240 open roles')
    expect(render([SOURCED[0]], STARTUP)).toContain('4 open roles')
  })

  it('says so instead of inventing a connection when a contact has no title', () => {
    const html = render([contact({ id: '9', name: 'Anon Person' })], BIGCO)
    expect(html).toContain('no title found')
  })
})

describe('RankedContactList — the accent is a claim, not decoration', () => {
  it('accents the top group when it is genuinely worth acting on', () => {
    expect(render([SOURCED[1]], BIGCO)).toContain('text-accent-deep')
  })

  it('does NOT accent a list whose best group is still people who will not answer', () => {
    // Exactly the megacorp-executives case: highlighting the least useful
    // people alive is the failure this ranking exists to stop.
    const html = render([SOURCED[0], SOURCED[3]], BIGCO)
    expect(html).toContain('Unlikely to move this application')
    expect(html).not.toContain('text-accent-deep')
  })
})

describe('RankedContactList — someone the user actually knows', () => {
  it('keeps a personal connection ahead of a stranger in the same bucket', () => {
    const html = render(
      [
        contact({ id: 'a', name: 'Stranger Eng', title: 'Senior Backend Engineer' }),
        contact({ id: 'b', name: 'Known Eng', title: 'Senior Backend Engineer', relationship: 'colleague' }),
      ],
      BIGCO
    )
    expect(html.indexOf('Known Eng')).toBeLessThan(html.indexOf('Stranger Eng'))
    expect(html).toContain('Colleague')
  })
})
