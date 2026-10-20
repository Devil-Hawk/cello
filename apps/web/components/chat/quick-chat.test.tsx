import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }))

vi.mock('@/app/(app)/chat/gate', () => ({ requireChat: async () => ({ id: 'u1' }) }))
vi.mock('@/components/chat/chat-view', () => ({ ChatView: () => null }))

import ChatPage from '@/app/(app)/chat/page'
import { QuickChat, quickChatHref } from './quick-chat'

// The Chat page is given the params from the link; ChatView is what it hands them to.
async function opened(href: string) {
  const q = new URL(href, 'http://x').searchParams
  const el = (await ChatPage({ searchParams: { ask: q.get('ask') ?? undefined, about: q.get('about') ?? undefined } })) as ReactElement<Record<string, unknown>>
  return el.props
}

describe('quickChatHref', () => {
  it('carries the words and the thing the person was looking at, and needs words', () => {
    expect(quickChatHref('  Is this role real?  ', { kind: 'role', ref: 'r1' })).toBe('/chat?ask=Is+this+role+real%3F&about=role%3Ar1')
    expect(quickChatHref('Compare these')).toBe('/chat?ask=Compare+these')
    expect(quickChatHref('   ', { kind: 'role', ref: 'r1' })).toBeNull()
  })

  it('cuts very long words at 2,000 characters', () => {
    expect(decodeURIComponent(quickChatHref('x'.repeat(5000))!.split('ask=')[1]).length).toBe(2000)
  })
})

describe('QuickChat', () => {
  it('shows nothing until Chat is known to be open for the person', () => {
    expect(renderToStaticMarkup(<QuickChat about={{ kind: 'role', ref: 'r1' }} />)).toBe('')
  })
})

describe('opening Chat from a role or company', () => {
  it('opens Chat with the role attached', async () => {
    const props = await opened(quickChatHref('Is this role real?', { kind: 'role', ref: 'r1' })!)
    expect(props.initialAbout).toEqual({ kind: 'role', ref: 'r1' })
    expect(props.initialAsk).toBe('Is this role real?')
  })

  it('opens Chat with the company attached', async () => {
    const props = await opened(quickChatHref('What do they build?', { kind: 'company', ref: 'c-9f2e' })!)
    expect(props.initialAbout).toEqual({ kind: 'company', ref: 'c-9f2e' })
    expect(props.initialAsk).toBe('What do they build?')
  })
})
