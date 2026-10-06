import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }))

import { QuickChat, quickChatHref } from './quick-chat'

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
