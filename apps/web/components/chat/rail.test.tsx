import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Rail, type RailChat } from './rail'

const noop = () => undefined
const chats: RailChat[] = [
  { id: 'a', title: 'Fintech notes', pinned: true },
  { id: 'b', title: 'AI roles at fintechs', pinned: false },
  { id: 'c', title: '', pinned: false },
]
const html = (over: Partial<Parameters<typeof Rail>[0]> = {}) =>
  renderToStaticMarkup(<Rail chats={chats} scheduled={[]} person={{ name: 'Ankit' }} onNew={noop} onRename={noop} onPin={noop} onArchive={noop} onDelete={noop} {...over} />)
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('Rail', () => {
  it('holds New chat, Scheduled and Recents, and no Library, Pinned or Projects', () => {
    const t = text(html())
    for (const word of ['New chat', 'Scheduled', 'Recents']) expect(t).toContain(word)
    for (const word of ['Library', 'Pinned', 'Projects', 'Project']) expect(t).not.toContain(word)
    expect([...html().matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].trim())).toEqual(['Scheduled', 'Recents'])
  })

  it('lists chats in the order given, pinned first, with the pin as a mark and a name for an untitled one', () => {
    const out = html()
    expect([...out.matchAll(/href="\/chat\/(\w)"/g)].map((m) => m[1])).toEqual(['a', 'b', 'c'])
    expect(out).toContain('lucide-pin')
    expect(text(out)).toContain('New chat')
    expect(out).toContain('aria-label="Options for New chat"')
  })

  it('puts the person last, with Settings behind their name', () => {
    const out = html()
    expect(out.lastIndexOf('href="/settings"')).toBeGreaterThan(out.lastIndexOf('href="/chat/c"'))
    expect(out.trimEnd().endsWith('</nav>')).toBe(true)
  })

  it('says what Scheduled and an empty Recents hold, and shows scheduled work with its detail', () => {
    expect(text(html({ chats: [] }))).toContain('Your chats and what Cello made from them stay here.')
    expect(text(html())).toContain('Nothing scheduled.')
    expect(text(html({ scheduled: [{ id: 's1', name: 'Find new roles', detail: 'Last read 8:00, found 3' }] }))).toContain('Find new roles Last read 8:00, found 3')
  })

  it('says nothing about Scheduled when it could not be read, and gives each scheduled item Do it now', () => {
    const none = html({ scheduled: null })
    expect(text(none)).not.toContain('Scheduled')
    expect(text(none)).not.toContain('Nothing scheduled')
    const out = html({ scheduled: [{ id: 's1', name: 'Find new roles', detail: 'Next at 8:00 tomorrow' }], onRunNow: noop })
    expect(out).toContain('aria-label="Do it now: Find new roles"')
  })

  it('offers Load more when more chats are stored, lists Earlier conversations after Recents, and has Sign out beside Settings', () => {
    expect(html()).not.toContain('Load more')
    expect(html({ hasMore: true })).toContain('Load more')
    const out = html({ earlier: [{ id: 'k1', title: 'Old question' }], onSignOut: noop })
    expect(text(out)).toContain('Earlier Old question')
    expect(out).toContain('href="/copilot?conversationId=k1"')
    expect([...out.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].trim())).toEqual(['Scheduled', 'Recents'])
    expect(out).toContain('aria-label="Sign out"')
    expect(html()).not.toContain('Sign out')
  })

  it('renders 200 chats', () => {
    const many = Array.from({ length: 200 }, (_, i): RailChat => ({ id: `c${i}`, title: `Chat ${i}`, pinned: false }))
    expect((html({ chats: many }).match(/href="\/chat\//g) ?? []).length).toBe(200)
  })
})
