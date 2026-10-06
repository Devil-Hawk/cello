import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), usePathname: () => '/roles' }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))

import { RolesView } from './roles-view'
import { DEFAULT_QUERY, NO_FILTERS, NO_MODEL_LINE, bandOf, filterCount, pastedTraceLine, uncheckedLine, groupByCompany, groupByType, groupCountLine, metaLine, orderItems, outsideLine, parseRolesQuery, postedAgo, rankItems, rolesHref, typeGroupHeader } from './logic'
import { applyTypeChanges, previousOwn, typeUndoOpen } from './type-change'
import { NO_REACTIONS, UNDO_MS, reactionReducer, undoOpen, visibleItems } from './reactions'
import { employerId, fixtureRoles, fixtureTypeCounts, fixtureTypeOptions } from './fixtures'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

const view = (over: Partial<Parameters<typeof RolesView>[0]> = {}) =>
  renderToStaticMarkup(
    <RolesView query={DEFAULT_QUERY} items={[]} picks={[]} total={0} newToday={0} groupCounts={{}} typeCounts={{}} typeOptions={fixtureTypeOptions} companyOptions={[]} needsSponsorship={false} untypedTotal={0} facts={{}} outside={{}} {...over} />,
  )

describe('the address', () => {
  it('has no parameters for the default view and keeps every filter in the address', () => {
    expect(rolesHref(DEFAULT_QUERY)).toBe('/roles')
    const q = parseRolesQuery({ tab: 'saved', group: 'company', level: 'senior', posted: '7d', country: 'us', remote: '1', agency: 'hide', limit: '50' })
    expect(q).toMatchObject({ tab: 'saved', group: 'company', level: 'senior', posted: '7d', country: 'US', remote: true, hideAgency: true, limit: 50 })
    expect(parseRolesQuery(Object.fromEntries(new URL(`http://x${rolesHref(q)}`).searchParams))).toEqual(q)
  })

  it('keeps Language, Chance and Mentions sponsorship in the address, counts them, and clears them', () => {
    const q = parseRolesQuery({ lang: 'de', chance: 'strong', sponsor: '1' })
    expect(q).toMatchObject({ language: 'de', chance: 'strong', sponsorship: true })
    expect(filterCount(q)).toBe(3)
    expect(rolesHref(q)).toBe('/roles?lang=de&chance=strong&sponsor=1')
    expect(parseRolesQuery(Object.fromEntries(new URL(`http://x${rolesHref(q)}`).searchParams))).toEqual(q)
    expect(rolesHref(q, NO_FILTERS)).toBe('/roles')
    expect(parseRolesQuery({ lang: 'klingon', chance: 'cannot_assess', sponsor: 'yes' })).toEqual(DEFAULT_QUERY)
  })

  it('falls back to the default for anything it does not know', () => {
    expect(parseRolesQuery({ tab: 'x', group: ['role-type'], level: 'wizard', posted: 'ever', country: 'USA', company: 'not-an-id', limit: '99999' })).toEqual({ ...DEFAULT_QUERY, limit: 300 })
    expect(parseRolesQuery({ limit: '-4' }).limit).toBe(25)
  })
})

describe('order and groups', () => {
  it('ranks judged roles by want and chance and puts the unchecked ones last, newest first', () => {
    const items = fixtureRoles(8, 2).map((i, n) => ({ ...i, wantP: n === 3 ? null : n === 5 ? 0.95 : 0.4, chance: n === 5 ? ('strong' as const) : ('possible' as const) }))
    const ranked = rankItems(items)
    expect(ranked[0].id).toBe(items[5].id)
    expect(ranked[ranked.length - 1].id).toBe(items[3].id)
    expect(orderItems(items, 'newest')[0].id).toBe(items[0].id)
  })

  it('takes the band from the picks, or the newest roles while picks are off', () => {
    const items = fixtureRoles(10, 3)
    expect(bandOf(items, []).kind).toBe('newest')
    expect(bandOf(items, []).items).toHaveLength(6)
    expect(bandOf(items, [{ ...items[7], explanation: 'x', kind: 'top' }]).kind).toBe('picks')
  })

  it('counts a group from SQL, never from the rows it was given', () => {
    const items = fixtureRoles(26, 3)
    const counts = { [employerId(0)]: 12, [employerId(1)]: 9, [employerId(2)]: 5 }
    const groups = groupByCompany(rankItems(items), counts, { [employerId(0)]: { open: 636, cannotRead: null } })
    expect(groups).toHaveLength(3)
    const first = groups.find((g) => g.companyId === employerId(0))!
    expect(first.items).toHaveLength(3)
    expect(first.count).toBe(12)
    expect(first.more).toBe(9)
    expect(groupCountLine(first)).toBe('12 for you of 636 open')
    expect(groupCountLine(groups.find((g) => g.companyId === employerId(1))!)).toBe('9 for you')
  })

  it('shows the reason for an employer it cannot read and never "0 for you"', () => {
    const groups = groupByCompany(fixtureRoles(2, 1), { [employerId(0)]: 0 }, { [employerId(0)]: { open: null, cannotRead: 'it asked for a human check' } })
    expect(groupCountLine(groups[0])).toBe('Cello cannot read this site: it asked for a human check')
    expect(groups[0].count).toBeNull()
    const unknown = groupByCompany(fixtureRoles(1, 1), {})
    expect(groupCountLine(unknown[0])).toBeNull()
    expect(unknown[0].more).toBeNull()
  })

  it('writes the lines from stored facts', () => {
    expect(outsideLine({ place: 120, title: 80, level: 14 })).toBe('214 roles outside your search this week: 120 place, 80 other role types, 14 level.')
    expect(outsideLine({ place: 0 })).toBeNull()
    const now = Date.UTC(2026, 9, 5, 12)
    expect(postedAgo(new Date(now - 5 * 3_600_000).toISOString(), now)).toBe('Posted 5h ago')
    expect(postedAgo(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('Posted 3 days ago')
    expect(metaLine({ ...fixtureRoles(1, 1)[0], legit: 'agency' }, now)).toContain('Agency')
  })
})

describe('Not for me and its Undo', () => {
  const [a, b] = fixtureRoles(2, 1)

  it('keeps an Undo open for ten seconds and takes the reaction back', () => {
    const done = { reaction: 'not_for_me' as const, reason: 'level' as const, at: 1000 }
    let s = reactionReducer(reactionReducer(NO_REACTIONS, { type: 'ask', id: a.id }), { type: 'done', id: a.id, value: done })
    expect(s.asking).toBeNull()
    expect(undoOpen(s.done[a.id], 1000 + UNDO_MS - 1)).toBe(true)
    expect(undoOpen(s.done[a.id], 1000 + UNDO_MS)).toBe(false)
    s = reactionReducer(s, { type: 'undo', id: a.id })
    expect(s.done[a.id]).toBeUndefined()
    expect(visibleItems([a, b], s, 1000 + UNDO_MS)).toHaveLength(2)
  })

  it('keeps the row while the Undo is open, wherever a regroup puts it, and drops it after', () => {
    const s = reactionReducer(NO_REACTIONS, { type: 'done', id: a.id, value: { reaction: 'not_for_me', reason: null, at: 0 } })
    expect(visibleItems([a, b], s, 5000).map((i) => i.id)).toEqual([a.id, b.id])
    expect(visibleItems([b, a], s, 5000).map((i) => i.id)).toEqual([b.id, a.id])
    expect(visibleItems([b, a], s, UNDO_MS + 1).map((i) => i.id)).toEqual([b.id])
    // Interested stays in the list after its Undo closes.
    const i = reactionReducer(NO_REACTIONS, { type: 'done', id: a.id, value: { reaction: 'interested', reason: null, at: 0 } })
    expect(visibleItems([a], i, UNDO_MS + 1)).toHaveLength(1)
  })

  it('offers Interested and Not for me on every row', () => {
    const html = text(view({ items: fixtureRoles(1, 1), total: 1 }))
    expect(html).toContain('Interested')
    expect(html).toContain('Not for me')
  })
})

describe('the Roles view', () => {
  it('says what to do when nothing is kept, with no group header or count', () => {
    const html = text(view())
    expect(html).toContain('Nothing new fits your search yet.')
    expect(html).toContain('Edit your search')
    expect(html).toContain('Follow an employer')
    expect(html).not.toMatch(/\b0 for you\b|Not scored|unscored/i)
    expect(html).toContain('Group by')
    expect(html).toContain('Sort')
    expect(html).toContain('Paste a link')
  })

  it('shows one role, and 25 roles without Show more, and 26 with it', () => {
    expect(text(view({ items: fixtureRoles(1, 1), total: 1 }))).not.toContain('Show more')
    expect(text(view({ items: fixtureRoles(25, 5), total: 25 }))).not.toContain('Show more')
    const more = view({ items: fixtureRoles(26, 5), total: 26 })
    expect(text(more)).toContain('Show more')
    expect(more).toContain('href="/roles?limit=50"')
    // 25 rows shown, not 26.
    expect((more.match(/class="r-row/g) ?? []).length).toBe(25)
  })

  it('counts the picks band toward the 25 rows, so the 26 role fixture shows Show more', () => {
    const withBand = view({ items: fixtureRoles(26, 5), total: 26, newToday: 41 })
    expect(text(withBand)).toContain('Show more')
    expect((withBand.match(/class="r-row/g) ?? []).length).toBe(25)
    expect(text(view({ items: fixtureRoles(25, 5), total: 25, newToday: 41 }))).not.toContain('Show more')
  })

  it('draws the title at the company name weight, whole, and opens the record and Company', () => {
    const items = fixtureRoles(8, 2).map((i) => ({ ...i, title: 'Staff Software Engineer, Applied AI and Developer Experience for Regulated Industries' }))
    const html = view({ items, total: 8 })
    expect(html).toContain(`href="/roles/${items[0].id}"`)
    expect(html).toContain(`href="/companies/${items[0].companyId}"`)
    expect(html).toContain('Staff Software Engineer, Applied AI and Developer Experience for Regulated Industries')
    expect(html).not.toMatch(/truncate|line-clamp/)
    expect(html).toMatch(/<a[^>]*class="r-name[^"]*"[^>]*>Staff Software/)
  })

  it('groups 40 employers, each with its logo, its honest count and "N more at X"', () => {
    const items = fixtureRoles(120, 40)
    const counts = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [employerId(n), 3 + n]))
    const html = view({ query: { ...DEFAULT_QUERY, group: 'company' }, items, total: 120, groupCounts: counts, facts: { [employerId(39)]: { open: 636, cannotRead: null } } })
    expect((html.match(/<section aria-label="Fixture Employer/g) ?? []).length).toBe(40)
    expect(text(html)).toContain('42 for you of 636 open')
    expect(text(html)).toContain('3 for you')
    expect(text(html)).toContain('39 more at Fixture Employer 40')
    expect(html).toContain(`href="/roles?company=${employerId(39)}"`)
    expect(html).not.toMatch(/>0 for you</)
  })

  it('shows an employer it cannot read with its reason and no count', () => {
    const html = text(view({ query: { ...DEFAULT_QUERY, group: 'company' }, items: fixtureRoles(2, 1), total: 2, groupCounts: { [employerId(0)]: 2 }, facts: { [employerId(0)]: { open: null, cannotRead: 'it needs a login' } } }))
    expect(html).toContain('Cello cannot read this site: it needs a login')
    expect(html).not.toMatch(/\d+ for you/)
  })

  it('puts the picks in a band above the list and the count line under it', () => {
    const items = fixtureRoles(12, 3)
    const html = text(view({ items, total: 12, newToday: 41, outside: { place: 120, level: 14 }, picks: [{ ...items[0], explanation: 'Because it is a strong fit.', kind: 'top' }] }))
    expect(html).toContain("Today's picks, 1 of 41 new")
    expect(html).toContain('Because it is a strong fit.')
    expect(html).toContain('134 roles outside your search this week: 120 place, 14 level.')
  })

  it('lists saved roles with closed ones marked, and hidden ones with their reason and Undo', () => {
    const saved = fixtureRoles(2, 1).map((i, n) => ({ ...i, closed: n === 1 }))
    expect(text(view({ query: { ...DEFAULT_QUERY, tab: 'saved' }, items: saved, total: 2 }))).toContain('Closed. You saved this.')
    const hidden = fixtureRoles(1, 1).map((i) => ({ ...i, hiddenReason: 'not_for_me' as const, reaction: { reaction: 'not_for_me' as const, reason: 'pay' as const } }))
    const html = text(view({ query: { ...DEFAULT_QUERY, tab: 'hidden' }, items: hidden, total: 1 }))
    expect(html).toContain('Not for me: Pay')
    expect(html).toContain('Undo')
  })

  it('never uses the words the page forbids', () => {
    const html = text(view({ items: fixtureRoles(12, 3), total: 12, newToday: 3 }))
    expect(html).not.toMatch(/receipt|unscored|Not scored|!/i)
  })
})

describe('role types', () => {
  it('keeps the role type filter, the other new filters and the grouping in the address', () => {
    const q = parseRolesQuery({ group: 'type', type: 'ai-engineer', following: '1', h1b: '1' })
    expect(q).toMatchObject({ group: 'type', roleType: 'ai-engineer', following: true, h1b: true })
    expect(parseRolesQuery(Object.fromEntries(new URL(`http://x${rolesHref(q)}`).searchParams))).toEqual(q)
    expect(parseRolesQuery({ type: 'Not A Type!' }).roleType).toBeNull()
  })

  it('counts a type group from SQL, and the untyped group says no number', () => {
    const items = fixtureRoles(7, 2)
    const groups = groupByType(items, { ...fixtureTypeCounts(items), 'ai-engineer': 31 })
    expect(groups[0]).toMatchObject({ key: 'ai-engineer', count: 31, more: 30 })
    expect(typeGroupHeader(groups[0])).toBe('AI Engineer, 31')
    const none = groupByType([{ ...items[0], type: null }], {})
    expect(typeGroupHeader(none[0])).toBe('No type yet')
  })

  it('draws Group by role type with each header equal to the SQL count, and a link to the rest', () => {
    const items = fixtureRoles(14, 3)
    const html = view({ query: { ...DEFAULT_QUERY, group: 'type' }, items, total: 14, typeCounts: { ...fixtureTypeCounts(items), 'ai-engineer': 31 } })
    expect(text(html)).toContain('AI Engineer, 31')
    expect(text(html)).toContain('29 more of this type')
    expect(html).toContain('href="/roles?type=ai-engineer"')
    expect(text(html)).toContain('Grouped by role type.')
  })

  it('shows type and level on a row, with the read mark only when a model set the type', () => {
    const [ai, fde] = fixtureRoles(2, 1)
    expect(text(view({ items: [ai], total: 1 }))).toContain('AI Engineer, Senior')
    expect(text(view({ items: [ai], total: 1 }))).not.toContain("Cello's read")
    expect(text(view({ items: [{ ...fde, level: null }], total: 1 }))).toContain('Forward Deployed Engineer')
    expect(text(view({ items: [{ ...fde, level: null }], total: 1 }))).toContain("Cello's read")
  })

  it('offers the Role type filter, Company and Following only, and Past H-1B filings only to a person who needs sponsorship', () => {
    const html = text(view({ items: fixtureRoles(2, 2), total: 2, companyOptions: [{ id: employerId(0), label: 'Fixture Employer 1' }] }))
    expect(html).toContain('Role type')
    expect(html).toContain('Any company')
    expect(html).toContain('Fixture Employer 1')
    expect(html).toContain('Following only')
    expect(html).not.toContain('Past H-1B filings')
    expect(text(view({ needsSponsorship: true }))).toContain('Past H-1B filings')
  })

  it('offers Language, Chance and Mentions sponsorship in the filter row', () => {
    const html = text(view({ query: parseRolesQuery({ lang: 'fr', chance: 'possible', sponsor: '1' }), items: fixtureRoles(2, 2), total: 2 }))
    expect(html).toContain('Any language')
    expect(html).toContain('Any chance')
    expect(html).toContain('Mentions sponsorship')
    expect(html).toContain('Filters (3)')
  })

  it('says how many roles are being checked, from the count it is given, and nothing when none are', () => {
    expect(uncheckedLine(12)).toBe('12 more are being checked. Until then they are listed by title and date.')
    expect(uncheckedLine(1)).toBe('1 more is being checked. Until then it is listed by title and date.')
    expect(uncheckedLine(0)).toBeNull()
    expect(text(view({ items: fixtureRoles(3, 1), total: 3, unchecked: 12 }))).toContain('12 more are being checked.')
    expect(text(view({ items: fixtureRoles(3, 1), total: 3, unchecked: 0 }))).not.toContain('being checked')
  })

  it('lists by title and date with a door to a free model when no model can run and nothing was reacted to', () => {
    const html = text(view({ items: fixtureRoles(3, 1), total: 3, hasModel: false, reacted: false }))
    expect(html).toContain(NO_MODEL_LINE)
    expect(html).toContain('Use free models')
    expect(text(view({ items: fixtureRoles(3, 1), total: 3, hasModel: false, reacted: true }))).not.toContain(NO_MODEL_LINE)
    expect(text(view({ items: fixtureRoles(3, 1), total: 3 }))).not.toContain(NO_MODEL_LINE)
  })

  it('says what a pasted link turned out to be, from the stored posting', () => {
    const [a] = fixtureRoles(1, 1)
    expect(pastedTraceLine({ ...a, pasted: false, traced: false })).toBeNull()
    expect(pastedTraceLine({ ...a, pasted: true, traced: false })).toBe("Cello could not trace this to the employer's own site.")
    expect(pastedTraceLine({ ...a, pasted: true, traced: true, legit: 'repost' })).toBe("This link is a repost on a job board. Cello found the employer's own posting.")
    expect(pastedTraceLine({ ...a, pasted: true, traced: true, legit: null })).toBeNull()
    expect(text(view({ items: [{ ...a, pasted: true, traced: false }], total: 1 }))).toContain('could not trace this')
  })

  it('moves a row to its new type at once, and Undo puts back what the person had', () => {
    const [a, b] = fixtureRoles(2, 1)
    const change = { to: { id: 'data-engineer', label: 'Data Engineer', own: true, origin: null }, prevOwn: previousOwn(a), at: 1000 }
    expect(change.prevOwn).toBeNull()
    expect(applyTypeChanges([a, b], { [a.id]: change }).map((i) => i.type?.id)).toEqual(['data-engineer', b.type?.id])
    expect(previousOwn({ type: { id: 'ml-engineer', label: 'ML Engineer', own: true, origin: null } })).toBe('ml-engineer')
    expect(typeUndoOpen(change, 1000 + UNDO_MS - 1)).toBe(true)
    expect(typeUndoOpen(change, 1000 + UNDO_MS)).toBe(false)
  })

  it('marks a pasted role "You pasted this" and no other', () => {
    const [a, b] = fixtureRoles(2, 1)
    const html = text(view({ items: [{ ...a, pasted: true }, b], total: 2 }))
    expect((html.match(/You pasted this/g) ?? []).length).toBe(1)
  })

  it('lists the roles Cello could not place on Hidden, each with Set type', () => {
    const hidden = fixtureRoles(2, 1).map((i) => ({ ...i, type: null, hiddenReason: 'unclassified' as const }))
    const html = text(view({ query: { ...DEFAULT_QUERY, tab: 'hidden' }, items: hidden, total: 2, untypedTotal: 2 }))
    expect(html).toContain('Cello could not tell the role type of these, 2')
    expect((html.match(/Set type/g) ?? []).length).toBe(2)
  })

  it('says when Cello last checked, in the state line and under an empty For you', () => {
    expect(text(view({ checkLine: 'Checked 3 hours ago.', items: fixtureRoles(2, 1), total: 2 }))).toContain('Ranked for you. Checked 3 hours ago.')
    expect(text(view({ checkLine: 'Checked 3 hours ago. Next check at 18:00 UTC.' }))).toContain('Nothing new fits your search yet. Checked 3 hours ago. Next check at 18:00 UTC.')
  })
})
