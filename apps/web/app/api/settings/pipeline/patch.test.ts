// Your search's on-its-own settings merge into the stored pipeline object without dropping anything else.

import { describe, expect, it } from 'vitest'
import { applyPatch, PatchSchema, SEND_AGREED_VERSION } from './patch'

const NOW = new Date('2026-10-06T12:00:00Z')
const stored = {
  want: { mode: 'me', chance: ['strong', 'possible'], watchedOnly: true, maxPerDay: 3 },
  send: { mode: 'me', maxPerDay: 3 },
  paused_at: '2026-10-01T00:00:00Z',
  morning: { pickAt: '06:00', summaryAt: '08:00', quietFrom: '21:00', quietTo: '08:00' },
  later: { kept: true },
}

describe('applyPatch', () => {
  it('changes only the keys it names and keeps the pause mark and unknown keys', () => {
    const out = applyPatch(stored, { pickAt: '07:30', quietFrom: '22:00' }, null, NOW)
    expect(out.morning).toEqual({ pickAt: '07:30', summaryAt: '08:00', quietFrom: '22:00', quietTo: '08:00' })
    expect(out.paused_at).toBe('2026-10-01T00:00:00Z')
    expect(out.later).toEqual({ kept: true })
    expect(out.want).toEqual(stored.want)
  })

  it('prepare Strong turns the rule on with Strong only and keeps the watched setting', () => {
    const out = applyPatch(stored, { prepareStrong: true, perDay: 5 }, null, NOW)
    expect(out.want).toEqual({ mode: 'rule', chance: ['strong'], watchedOnly: true, maxPerDay: 5 })
    expect(applyPatch(out, { prepareStrong: false }, null, NOW).want).toMatchObject({ mode: 'me' })
  })

  it('weekly pace is set, and null clears it', () => {
    const set = applyPatch({}, { weeklyPace: 10 }, null, NOW)
    expect(set.weeklyPace).toBe(10)
    expect('weeklyPace' in applyPatch(set, { weeklyPace: null }, null, NOW)).toBe(false)
  })

  it('Send for me needs the agreement and an extension token, and binds to that token', () => {
    expect(() => applyPatch(stored, { send: { on: true } }, 'tok', NOW)).toThrow(/agree/)
    expect(() => applyPatch(stored, { send: { on: true, agreed: true } }, null, NOW)).toThrow(/extension/)
    const on = applyPatch(stored, { send: { on: true, agreed: true, perDay: 4 } }, 'tok', NOW)
    expect(on.send).toEqual({ mode: 'auto', maxPerDay: 4, tokenId: 'tok', agreedAt: NOW.toISOString(), agreedVersion: SEND_AGREED_VERSION })
    expect(applyPatch(on, { send: { on: false } }, null, NOW).send).toMatchObject({ mode: 'me', tokenId: 'tok' })
  })

  it('a bad stored value is treated as empty, never thrown over', () => {
    expect(applyPatch('nope', { summary: true }, null, NOW)).toEqual({ summary: true })
  })
})

describe('PatchSchema', () => {
  it('refuses a pick time outside 05:00 to 10:00, a daily number over 10 and unknown keys', () => {
    expect(PatchSchema.safeParse({ pickAt: '04:59' }).success).toBe(false)
    expect(PatchSchema.safeParse({ pickAt: '10:01' }).success).toBe(false)
    expect(PatchSchema.safeParse({ pickAt: '10:00' }).success).toBe(true)
    expect(PatchSchema.safeParse({ perDay: 11 }).success).toBe(false)
    expect(PatchSchema.safeParse({ pipeline: {} }).success).toBe(false)
  })
})
