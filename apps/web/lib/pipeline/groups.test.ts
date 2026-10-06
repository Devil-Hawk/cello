import { describe, expect, it } from 'vitest'
import { DEMO_APPLICATIONS } from '@/lib/access/fixtures/pipeline'
import { groupOf } from './groups'
import { APPLICATION_GROUPS } from './types'

describe('groupOf', () => {
  it('puts every demo application in exactly one group, and a role that was only saved in none', () => {
    const placed = DEMO_APPLICATIONS.map((a) => ({ stage: a.stage, group: groupOf({ state: null, stage: a.stage }, null) }))
    for (const { stage, group } of placed) {
      if (stage === 'discovered') expect(group).toBeNull()
      else expect(APPLICATION_GROUPS, `stage ${stage}`).toContain(group)
    }
    // the demo has applications in the groups that matter
    expect(new Set(placed.map((p) => p.group).filter(Boolean)).size).toBeGreaterThanOrEqual(3)
  })

  it('reads the stage of a row with no state', () => {
    const g = (stage: string) => groupOf({ state: null, stage }, null)
    expect(g('applied')).toBe('waiting')
    expect(g('screen')).toBe('interview')
    expect(g('interview')).toBe('interview')
    expect(g('offer')).toBe('interview')
    expect(g('accepted')).toBe('interview')
    expect(g('rejected')).toBe('closed')
    expect(g('withdrawn')).toBe('closed')
    expect(g('ghosted')).toBe('closed')
    expect(g('discovered')).toBeNull()
  })

  it('reads the state of a row Cello is working on', () => {
    const g = (state: Parameters<typeof groupOf>[0]['state']) => groupOf({ state, stage: 'discovered' }, null)
    expect(g('needs_you')).toBe('needs_you')
    expect(g('ready')).toBe('needs_you')
    expect(g('not_sent')).toBe('needs_you')
    expect(g('preparing')).toBe('preparing')
    expect(g('scheduled')).toBe('preparing')
    expect(g('applying')).toBe('preparing')
    expect(g('paused')).toBe('preparing')
    expect(g('skipped')).toBe('closed')
  })

  it('a sent application waits on the employer unless the search says something is due', () => {
    const sent = { state: 'sent' as const, stage: 'applied' }
    expect(groupOf(sent, null)).toBe('waiting')
    expect(groupOf({ ...sent, state: 'confirmed' }, null)).toBe('waiting')
    for (const kind of ['reply', 'offer_due', 'follow_up_due', 'gone_quiet'] as const) expect(groupOf(sent, { kind })).toBe('needs_you')
    // a reply on an interview row still needs the person; no reply leaves it in the interview group
    expect(groupOf({ state: null, stage: 'interview' }, { kind: 'reply' })).toBe('needs_you')
    expect(groupOf({ state: null, stage: 'interview' }, null)).toBe('interview')
  })

  it('closes on a reason, and an application found in email waits for the person', () => {
    expect(groupOf({ state: 'sent', stage: 'applied', closed_reason: 'no_reply' }, null)).toBe('closed')
    expect(groupOf({ state: 'not_sent', stage: 'discovered', closed_reason: 'posting_closed' }, null)).toBe('closed')
    expect(groupOf({ state: null, stage: 'applied', found_state: 'to_confirm' }, null)).toBe('needs_you')
    expect(groupOf({ state: null, stage: 'applied', found_state: 'confirmed' }, null)).toBe('waiting')
  })
})
