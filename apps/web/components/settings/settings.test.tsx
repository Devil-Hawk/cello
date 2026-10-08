// Settings in the sections of 4.12: their order, the owner-only part, the doors in the person's order, the free
// count with its tooltip sentence, the spend lines and the activity lines. Fixtures per state.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: () => undefined }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => undefined } }) }))

import { SECTIONS, SettingsView, TAB_TARGET, spendLines } from './settings-view'
import { ModelsPanel, usingNow, type ModelsView } from './models-section'
import { ActivityRows, activityLine } from './activity-list'

const text = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/<!-- -->/g, '')

const view = (over: Partial<ModelsView> = {}): ModelsView => ({
  rungs: [
    { rung: 'R1', state: 'not_set_up' },
    { rung: 'R2', state: 'not_set_up' },
    { rung: 'R3', state: 'ready' },
    { rung: 'R4', state: 'ready' },
  ],
  ceiling: 'R4',
  order: ['R3', 'R4', 'R1', 'R2'],
  creditBought: false,
  freeToday: 31,
  freeLimit: 50,
  resetsAt: '2026-10-07T20:00:00Z',
  ...over,
})

describe('Settings sections', () => {
  it('lists Account, Models, Connections, Spend, Notifications, Your data, Appearance and Advanced in that order', () => {
    const out = text(<SettingsView owner={false} />)
    const at = SECTIONS.map((s) => out.indexOf(`id="${s.id}-h"`))
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(SECTIONS.map((s) => s.label)).toEqual(['Account', 'Models', 'Connections', 'Spend', 'Notifications', 'Your data', 'Appearance', 'Advanced'])
  })

  it('shows Demo codes to the owner only', () => {
    expect(text(<SettingsView owner={false} />)).not.toContain('Demo codes')
    const out = text(<SettingsView owner />)
    expect(out).toContain('Demo codes')
    expect(out).toContain('Open the scorecard')
  })

  it('names no model id anywhere on the page', () => {
    const out = text(<SettingsView owner />)
    expect(out).not.toMatch(/gpt-|claude-|gemini-|anthropic\/|openai\/|google\/|:free/i)
  })

  it('gives every old tab a place', () => {
    for (const tab of ['connections', 'sources', 'search', 'mcp', 'tokens', 'api-keys', 'provider', 'model']) expect(TAB_TARGET[tab]).toBeTruthy()
  })
})

describe('Models', () => {
  it('shows the free count with the credit sentence beside the 50, and the credit switch', () => {
    const out = text(<ModelsPanel view={view()} onSave={() => undefined} />)
    expect(out).toContain('31 of')
    expect(out).toContain('free requests today. Resets')
    expect(out).toContain('1,000 a day after you buy $10 of OpenRouter credit.')
    expect(out).toContain('I have bought $10 of OpenRouter credit')
    expect(out).not.toContain('Unavailable')
  })

  it('lists the doors in the person\'s order with Not set up, and the highest Cello may use', () => {
    const out = text(<ModelsPanel view={view()} onSave={() => undefined} />)
    const doors = out.slice(out.indexOf('Your doors'))
    expect(doors.indexOf('Free models')).toBeLessThan(doors.indexOf('Your own key'))
    expect(doors.indexOf('Your own key')).toBeLessThan(doors.indexOf('This browser'))
    expect(out).toContain('Not set up')
    expect(out).toContain('Highest Cello may use')
    for (const label of ['No model', 'This browser', 'This computer']) expect(out).toContain(label)
  })

  it('uses the first set up door in the person\'s order that is not above the highest they allow', () => {
    expect(usingNow(view())).toBe('R3')
    expect(usingNow(view({ order: ['R4', 'R3', 'R1', 'R2'] }))).toBe('R4')
    expect(usingNow(view({ ceiling: 'R2', order: ['R4', 'R3', 'R1', 'R2'] }))).toBe('R0')
    expect(usingNow(view({ rungs: view().rungs.map((r) => ({ ...r, state: 'not_set_up' as const })) }))).toBe('R0')
  })

  it('with no model says what still works', () => {
    expect(text(<ModelsPanel view={view({ ceiling: 'R0' })} onSave={() => undefined} />)).toContain('Its own checks still run')
  })

  it('shows a save failure beside the control', () => {
    expect(text(<ModelsPanel view={view()} error="Could not save. Nothing changed." onSave={() => undefined} />)).toContain('Could not save. Nothing changed.')
  })
})

describe('Spend', () => {
  it('says You pay nothing with no key', () => {
    expect(spendLines(null, false)).toEqual(['You pay nothing. Cello uses free models and your own computer.'])
  })
  it('states what was used and what is held', () => {
    expect(spendLines({ spentUsd: 0.03, monthlyUsd: 10, heldUsd: 0.12, periodStart: '2026-10' }, true)).toEqual(['$0.03 of $10.00 used this month.', '$0.12 held for work in progress.'])
    expect(spendLines({ spentUsd: 0, monthlyUsd: 10, heldUsd: 0, periodStart: '2026-10' }, true)).toEqual(['$0.00 of $10.00 used this month.'])
  })
})

describe('Activity', () => {
  const row = { step: 'chance_check', door: 'routine', rung: 'R3', count: 12, usd: 0 }
  it('reads a row as work, requests, door and cost when there was one', () => {
    expect(activityLine(row)).toBe('Chance check: 12 requests from Scheduled work, on free models')
    expect(activityLine({ ...row, count: 1, rung: 'R4', usd: 0.04 })).toBe('Chance check: 1 request from Scheduled work, on your own key, $0.04')
  })
  it('says nothing happened when nothing did', () => {
    expect(text(<ActivityRows rows={[]} />)).toContain('Nothing in the last 7 days.')
  })
})
