import { describe, expect, it } from 'vitest'
import { continueBody, MAX_EXP_AHEAD_S, pgJsonbText, signContinue, verifyContinue } from './sign'

const KEY = 'k'.repeat(32)
const NOW = Date.parse('2026-10-08T12:00:00Z')

describe('verifyContinue', () => {
  it('accepts a body signed with the key, whose exp is five minutes ahead', () => {
    const body = continueBody({ reason: 'routine', routine_id: 'r1' }, NOW)
    const verdict = verifyContinue(body, signContinue(body, KEY), NOW, KEY)
    expect(verdict).toMatchObject({ ok: true, payload: { reason: 'routine', routine_id: 'r1' } })
  })

  it('refuses a missing, wrong or altered signature', () => {
    const body = continueBody({ reason: 'routine', routine_id: 'r1' }, NOW)
    expect(verifyContinue(body, null, NOW, KEY)).toEqual({ ok: false, reason: 'no_signature' })
    expect(verifyContinue(body, signContinue(body, 'x'.repeat(32)), NOW, KEY)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyContinue(body.replace('r1', 'r2'), signContinue(body, KEY), NOW, KEY)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyContinue(body, 'zz', NOW, KEY)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses an old signed body replayed after five minutes', () => {
    const body = continueBody({ reason: 'routine', routine_id: 'r1' }, NOW)
    const sig = signContinue(body, KEY)
    expect(verifyContinue(body, sig, NOW + (MAX_EXP_AHEAD_S - 1) * 1000, KEY).ok).toBe(true)
    expect(verifyContinue(body, sig, NOW + (MAX_EXP_AHEAD_S + 1) * 1000, KEY)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses an exp too far ahead, a body that is not a request, and an unknown reason', () => {
    const far = JSON.stringify({ reason: 'routine', exp: Math.floor(NOW / 1000) + 3600 })
    expect(verifyContinue(far, signContinue(far, KEY), NOW, KEY)).toEqual({ ok: false, reason: 'too_far' })
    expect(verifyContinue('not json', signContinue('not json', KEY), NOW, KEY)).toEqual({ ok: false, reason: 'bad_body' })
    const odd = JSON.stringify({ reason: 'delete_everything', exp: Math.floor(NOW / 1000) + 60 })
    expect(verifyContinue(odd, signContinue(odd, KEY), NOW, KEY)).toEqual({ ok: false, reason: 'bad_body' })
  })

  it('accepts compact JSON signed over the same body as Postgres writes it', () => {
    const exp = Math.floor(NOW / 1000) + 300
    // what the sweeper signs: body::text of {"reason": "routine", "routine_id": "r1", "exp": ...}
    const pgText = `{"exp": ${exp}, "reason": "routine", "routine_id": "r1"}`
    const compact = JSON.stringify({ reason: 'routine', routine_id: 'r1', exp })
    expect(pgJsonbText({ reason: 'routine', routine_id: 'r1', exp })).toBe(pgText)
    expect(verifyContinue(compact, signContinue(pgText, KEY), NOW, KEY).ok).toBe(true)
    // a different body under that signature is still refused
    const other = JSON.stringify({ reason: 'routine', routine_id: 'r2', exp })
    expect(verifyContinue(other, signContinue(pgText, KEY), NOW, KEY)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('throws when no secret is set, so the route can say not configured', () => {
    const had = process.env.AGENT_CONTINUE_SECRET
    delete process.env.AGENT_CONTINUE_SECRET
    try {
      expect(() => verifyContinue('{}', 'ab', NOW)).toThrow(/AGENT_CONTINUE_SECRET/)
    } finally {
      if (had !== undefined) process.env.AGENT_CONTINUE_SECRET = had
    }
  })
})
