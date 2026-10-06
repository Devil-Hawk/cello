// Old Ask Cello links forward to Chat, carrying a typed question and a chat id.

import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

import AskPage from './page'
import AskChatPage from './[id]/page'

describe('/ask redirects', () => {
  it('/ask goes to /chat, and keeps a typed question', () => {
    expect(() => AskPage({ searchParams: {} })).toThrow('REDIRECT:/chat')
    expect(() => AskPage({ searchParams: { ask: 'Find roles at fintechs & more' } })).toThrow('REDIRECT:/chat?ask=Find%20roles%20at%20fintechs%20%26%20more')
  })

  it('/ask/[id] opens the same chat, and an id cannot point anywhere else', () => {
    expect(() => AskChatPage({ params: { id: 'abc-123' } })).toThrow('REDIRECT:/chat/abc-123')
    expect(() => AskChatPage({ params: { id: '../../admin' } })).toThrow('REDIRECT:/chat/..%2F..%2Fadmin')
  })
})
