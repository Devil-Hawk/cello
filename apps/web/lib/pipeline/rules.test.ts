import { describe, expect, it } from 'vitest'
import { candidatesForRule, type RuleCandidate } from './rules'
import { readPipelineSettings } from './settings'

const want = (over: object = {}) => readPipelineSettings({ pipeline: { want: { mode: 'rule', chance: ['strong'], watchedOnly: true, maxPerDay: 3, ...over } } }).want

const cand = (jobId: string, over: Partial<RuleCandidate> = {}): RuleCandidate => ({
  jobId, chance: 'strong', want: 0.5, followed: true, filtered: false, reacted: false, hasApplication: false, sent: false, ...over,
})

describe('candidatesForRule', () => {
  it('starts nothing unless the person chose the rule', () => {
    expect(candidatesForRule(want({ mode: 'me' }), [cand('a')])).toEqual({ start: [], heldBack: 0 })
  })

  it('keeps only Strong roles at followed companies that are not filtered, reacted to, applied to or sent', () => {
    const r = candidatesForRule(want(), [
      cand('ok'),
      cand('possible', { chance: 'possible' }),
      cand('stretch', { chance: 'stretch' }),
      cand('unknown', { chance: null }),
      cand('unfollowed', { followed: false }),
      cand('filtered', { filtered: true }),
      cand('reacted', { reacted: true }),
      cand('applied', { hasApplication: true }),
      cand('sent', { sent: true }),
    ])
    expect(r.start.map((c) => c.jobId)).toEqual(['ok'])
  })

  it('lets the person widen the rule to Possible and to companies they do not follow', () => {
    const r = candidatesForRule(want({ chance: ['strong', 'possible'], watchedOnly: false }), [
      cand('possible', { chance: 'possible' }),
      cand('unfollowed', { followed: false }),
      cand('stretch', { chance: 'stretch' }),
    ])
    expect(r.start.map((c) => c.jobId)).toEqual(['unfollowed', 'possible'])
  })

  it('orders by want, then by chance, then by the order it came in', () => {
    const r = candidatesForRule(want({ chance: ['strong', 'possible'], maxPerDay: 10 }), [
      cand('low', { want: 0.2 }),
      cand('high-possible', { want: 0.9, chance: 'possible' }),
      cand('high-strong', { want: 0.9 }),
      cand('unlearned', { want: null }),
      cand('tie-a', { want: 0.5 }),
      cand('tie-b', { want: 0.5 }),
    ])
    expect(r.start.map((c) => c.jobId)).toEqual(['high-strong', 'high-possible', 'tie-a', 'tie-b', 'low', 'unlearned'])
  })

  it('stops at the day\'s cap, counts what the rule already started, and says how many were held back', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id, i) => cand(id, { want: 0.9 - i / 10 }))
    expect(candidatesForRule(want(), many)).toMatchObject({ start: [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }], heldBack: 2 })
    expect(candidatesForRule(want(), many, 2)).toMatchObject({ start: [{ jobId: 'a' }], heldBack: 4 })
    expect(candidatesForRule(want(), many, 3)).toMatchObject({ start: [], heldBack: 5 })
  })
})

describe('readPipelineSettings', () => {
  it('reads defaults from nothing, and turns nothing on', () => {
    for (const prefs of [null, undefined, {}, { pipeline: null }, { pipeline: [] }, { pipeline: 'on' }]) {
      const s = readPipelineSettings(prefs)
      expect(s.want).toEqual({ mode: 'me', chance: ['strong'], watchedOnly: true, maxPerDay: 3 })
      expect(s.send).toMatchObject({ mode: 'me', maxPerDay: 3 })
      expect(s.resumeApproval).toBe(true)
      expect(s.pausedAt).toBeNull()
    }
  })

  it('reads what is stored', () => {
    const s = readPipelineSettings({
      pipeline: { send: { mode: 'auto', maxPerDay: 5, tokenId: '5b0c9c2c-3f7e-4a58-9f1e-1c2d3e4f5a6b' }, want: { mode: 'rule', maxPerDay: 2 }, paused_at: '2026-10-13T08:00:00Z', resumeApproval: false },
    })
    expect(s.send).toMatchObject({ mode: 'auto', maxPerDay: 5, tokenId: '5b0c9c2c-3f7e-4a58-9f1e-1c2d3e4f5a6b' })
    expect(s.want).toMatchObject({ mode: 'rule', maxPerDay: 2, chance: ['strong'] })
    expect(s.pausedAt).toBe('2026-10-13T08:00:00Z')
    expect(s.resumeApproval).toBe(false)
  })

  it('reads an invalid value as its default, so a bad stored value never turns Send for me on', () => {
    const s = readPipelineSettings({ pipeline: { send: { mode: 'yes please', maxPerDay: 500, tokenId: 'not-a-uuid' }, want: { maxPerDay: 0, chance: [] } } })
    expect(s.send).toEqual({ mode: 'me', maxPerDay: 3 })
    expect(s.want.maxPerDay).toBe(3)
    expect(s.want.chance).toEqual(['strong'])
  })
})
