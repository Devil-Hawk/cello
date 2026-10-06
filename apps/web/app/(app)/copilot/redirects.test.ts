// /copilot forwards to Chat once Chat is shown to everyone, and is the old page until then. /agent forwards to /copilot.

import { describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ on: false }))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { on: flags.on }, error: null }) }) }) }),
  }),
}))
vi.mock('./legacy', () => ({ default: () => null }))

import CopilotPage from './page'
import AgentPage from '../agent/page'

describe('/copilot and /agent', () => {
  it('/copilot is still the old page while Chat is not shown to everyone', async () => {
    flags.on = false
    const out = await CopilotPage({ searchParams: { ask: 'hello' } })
    expect(out).toBeTruthy()
  })

  it('/copilot goes to /chat once Chat is shown, and keeps a typed question', async () => {
    flags.on = true
    await expect(CopilotPage({ searchParams: {} })).rejects.toThrow('REDIRECT:/chat')
    await expect(CopilotPage({ searchParams: { ask: 'Find roles & more' } })).rejects.toThrow('REDIRECT:/chat?ask=Find%20roles%20%26%20more')
  })

  it('/agent goes to /copilot', () => {
    expect(() => AgentPage()).toThrow('REDIRECT:/copilot')
  })
})
