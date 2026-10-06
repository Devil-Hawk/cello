// Your search: the live line, what runs on its own (every number traced, a job's bookkeeping never printed), the
// settings that govern it, and Your browser with Send for me in each of its states.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))

import { liveLine } from './search-page'
import { JOBS, JobRow, costOf, foundLine, type Beat } from './on-its-own'
import { OnItsOwnForm, diff, toForm, type PipelineView } from './on-its-own-settings'
import { BrowserPanel, SEND_SENTENCE, type BrowserState } from './your-browser'

const html = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/<!-- -->/g, '')
const beat = (job: string, found: Record<string, unknown> | null, over: Partial<Beat> = {}): Beat => ({ job, succeeded_at: '2026-10-06T10:00:00Z', next_due_at: null, found, failure: null, ...over })

describe('the live line', () => {
  it('says how many of today\'s new roles fit, counted from what the read kept and what it left outside', () => {
    expect(liveLine(12, 29)).toBe("12 of today's 41 new roles fit this.")
    expect(liveLine(1, 0)).toBe("1 of today's 1 new role fits this.")
  })
  it('says so when nothing was read today, never 0 of 0', () => {
    expect(liveLine(0, 0)).toBe('Cello has not read any new roles today.')
  })
})

describe('what Cello does on its own', () => {
  it('has a row for every built-in job, including Pick today\'s roles, and Send it now on the summary', () => {
    expect(JOBS.map((j) => j.label)).toEqual(['Find new roles', "Pick today's roles", 'Read your mail', 'Find people in your mail', 'Daily summary', 'Learning'])
    expect(JOBS.find((j) => j.job === 'summary.send')?.doIt?.label).toBe('Send it now')
  })

  it('never prints the sync\'s cursor or its carry as a count', () => {
    const line = foundLine('network.sync', beat('network.sync', { cursor: 1790000000, people: 12, pending: ['a', 'b'], sendAs: ['x@y.z'], leftOut: { counts: { automated: 4 } } }))
    expect(line).toBe('12 people found so far.')
    expect(line).not.toMatch(/1790000000|cursor|pending/)
  })

  it('reads each job\'s own keys as a sentence', () => {
    expect(foundLine('roles.check', beat('roles.check', { employers: 30, read: 28, new: 41, matched: 12, cannot_read: 2 }))).toBe('Read 28 employers. 41 new roles, 12 kept for you. Could not read 2 employers.')
    expect(foundLine('inbox.sync', beat('inbox.sync', { read: 1, applications: 2 }))).toBe('Read 1 message. 2 applications found.')
    expect(foundLine('summary.send', beat('summary.send', { outcome: 'empty' }))).toBe('Nothing to say, so nothing was sent.')
    expect(foundLine('harness.learn', beat('harness.learn', { counted: 5, people: 1, failed: 0 }))).toBe('Counted 5 things from your record.')
  })

  it('says Nothing new for a run with nothing to report, Has not run yet for no heartbeat, and a failure as its class', () => {
    expect(foundLine('roles.check', beat('roles.check', {}))).toBe('Nothing new.')
    expect(foundLine('roles.pick', undefined)).toBe('Has not run yet.')
    expect(foundLine('inbox.sync', beat('inbox.sync', null, { failure: 'sync_failed' }))).toBe('The last run did not finish. Cello will try again.')
  })

  it('shows a cost only when the ledger recorded one for that job', () => {
    const rows = [{ step: 'roles.pick', door: 'routine', rung: 'R3', count: 3, usd: 0.04 }, { step: 'roles.pick.judge', door: 'routine', rung: 'R3', count: 3, usd: 0.01 }, { step: 'chat', door: 'chat', rung: 'R3', count: 1, usd: 1 }]
    expect(costOf('roles.pick', rows)).toBeCloseTo(0.05)
    expect(costOf('inbox.sync', rows)).toBe(0)
    const job = JOBS.find((j) => j.job === 'roles.pick')!
    expect(html(<JobRow job={job} beat={beat('roles.pick', { picked: 6 })} cost={0.05} loading={false} busy={false} onRun={() => undefined} />)).toContain('$0.05 this week.')
    expect(html(<JobRow job={job} beat={beat('roles.pick', { picked: 6 })} cost={0} loading={false} busy={false} onRun={() => undefined} />)).not.toContain('$')
  })
})

const view: PipelineView = {
  settings: {
    want: { mode: 'me', chance: ['strong'], watchedOnly: true, maxPerDay: 3 },
    resumeApproval: true,
    send: { mode: 'me', maxPerDay: 3 },
    cover: 'when_asked',
    findContacts: false,
    followUps: { afterDays: 7, on: true },
    summary: false,
    morning: { pickAt: '06:00', summaryAt: '08:00', quietFrom: '21:00', quietTo: '08:00' },
    pausedAt: null,
  },
  weeklyPace: null,
  digest: false,
}

describe('the settings that govern it', () => {
  const form = toForm(view)
  it('shows the pick time, quiet hours, the daily limit and each choice', () => {
    const out = html(<OnItsOwnForm form={form} onChange={() => undefined} onSave={() => undefined} />)
    for (const text of ["Pick today&#x27;s roles at", 'value="06:00"', 'value="21:00"', 'value="08:00"', 'Prepare my Strong picks each morning', 'At most this many a day, 1 to 10', 'Show me each resume first', 'Draft follow-ups when someone has gone quiet', 'Send me a daily summary', 'Applications a week you are aiming for']) {
      expect(out).toContain(text)
    }
    expect(out).toContain('Quiet hours hold messages and email to you. They never stop Cello from finding roles.')
  })

  it('sends only what changed, and clears the weekly pace with null', () => {
    expect(diff(form, form)).toEqual({})
    expect(diff(form, { ...form, pickAt: '07:30', summary: true, prepareStrong: true, perDay: '5' })).toEqual({ pickAt: '07:30', summary: true, prepareStrong: true, perDay: 5 })
    expect(diff({ ...form, weeklyPace: '10' }, { ...form, weeklyPace: '' })).toEqual({ weeklyPace: null })
  })

  it('reads the summary as on when the older digest opt-in is on', () => {
    expect(toForm({ ...view, digest: true }).summary).toBe(true)
  })
})

describe('Your browser', () => {
  const base: BrowserState = { connected: true, lastSeen: new Date(Date.now() - 3 * 86_400_000).toISOString(), sendForMe: false, paused: false, cap: 3, sentToday: 0, triesToday: 0 }
  const panel = (state: BrowserState, extra: Partial<React.ComponentProps<typeof BrowserPanel>> = {}) => html(<BrowserPanel state={state} onConnect={() => undefined} onDisconnect={() => undefined} onSend={() => undefined} {...extra} />)

  it('not connected: says so and offers to connect, with no Send for me', () => {
    const out = panel({ ...base, connected: false, lastSeen: null })
    expect(out).toContain('Your browser is not connected.')
    expect(out).toContain('Connect my browser')
    expect(out).not.toContain('Send for me')
  })

  it('connected and off: shows last seen, its full sentence, and the turn-on key waits on reading it', () => {
    const out = panel(base)
    expect(out).toContain('Last seen 3 days ago.')
    expect(out).toContain(SEND_SENTENCE.replace(/'/g, '&#x27;'))
    expect(out).toContain('Daily limit, 1 to 10')
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Turn on Send for me/)
    expect(out).toContain('Disconnect')
  })

  it('on: shows today\'s count and the limit, and a way to turn it off', () => {
    const out = panel({ ...base, sendForMe: true, sentToday: 2, triesToday: 3, cap: 4 })
    expect(out).toContain('Send for me is on. 2 sent today, 3 tried, limit 4 a day.')
    expect(out).toContain('Turn off Send for me')
  })

  it('paused: says nothing is prepared or sent', () => {
    expect(panel({ ...base, paused: true })).toContain('Cello is paused, so nothing is prepared or sent.')
  })

  it('shows a new token once, and a failure beside the control', () => {
    const out = panel(base, { token: 'cello_pat_ABC', note: 'Could not do that. Nothing changed.' })
    expect(out).toContain('cello_pat_ABC')
    expect(out).toContain('It is shown once')
    expect(out).toContain('Could not do that. Nothing changed.')
  })
})
