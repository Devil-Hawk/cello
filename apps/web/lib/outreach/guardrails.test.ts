// Tests for lib/outreach/guardrails.ts — the gate that decides whether a
// machine-drafted email reaches a real human being under the user's name.
//
// WHY THIS FILE EXISTS
//   Until now this file had no tests at all. It is the single most
//   consequential pure function in the product: everything else Cello gets
//   wrong is recoverable, and a wrongly-sent email is not. A design review
//   also found the UI printing "Human-approve is on" as a hardcoded string
//   while `canSendNow` will happily send an unapproved message when
//   `autoSend` is true — so the promise and the gate can disagree. The point
//   of these tests is that the gate's behaviour is now pinned in executable
//   form, and any future change that loosens it has to delete an assertion
//   that says out loud why it existed.
//
// No DB, no network: guardrails.ts is deliberately framework-free, so
// everything here is synchronous.

import { describe, expect, it } from 'vitest'
import { canSendNow, checkDailyCap, followUpWindowElapsed } from './guardrails'
import { DEFAULT_OUTREACH_PREFS, type OutreachMessageRow, type OutreachPreferences, type OutreachStatus } from './types'

function prefs(overrides: Partial<OutreachPreferences> = {}): OutreachPreferences {
  return { ...DEFAULT_OUTREACH_PREFS, ...overrides }
}

function message(status: OutreachStatus, overrides: Partial<OutreachMessageRow> = {}): OutreachMessageRow {
  return {
    id: 'msg-1',
    user_id: 'user-1',
    contact_id: 'contact-1',
    job_id: 'job-1',
    company_id: 'company-1',
    run_id: null,
    to_email: 'someone@example.com',
    to_name: 'Someone Real',
    subject: 'Quick question about the ML engineer role',
    body: 'Hello…',
    status,
    kind: 'initial',
    parent_id: null,
    gmail_message_id: null,
    gmail_thread_id: null,
    error: null,
    sent_at: null,
    created_at: '2026-07-01T09:00:00.000Z',
    updated_at: '2026-07-01T09:00:00.000Z',
    ...overrides,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('canSendNow — guardrail (1), the approve queue', () => {
  it('DEFAULTS TO BLOCKING: a fresh draft cannot send under default preferences', () => {
    // The product's central safety claim, in one assertion. DEFAULT_OUTREACH_PREFS
    // carries autoSend: false, so the out-of-the-box state must refuse.
    const gate = canSendNow(message('pending_review'), prefs())
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/awaiting approval/i)
  })

  it('blocks an unapproved draft and says why, so the UI never has to guess', () => {
    const gate = canSendNow(message('pending_review'), prefs({ autoSend: false }))
    expect(gate).toEqual({
      allowed: false,
      reason: 'awaiting approval (auto-send is disabled)',
    })
  })

  it('allows an unapproved draft ONLY when the user turned autoSend on', () => {
    // This is the branch that can contradict a UI claiming "human-approve is
    // on". It is intended behaviour — the user opted in — but any surface that
    // asserts human approval must read `autoSend` rather than hardcode a
    // promise, because this line is what actually decides.
    expect(canSendNow(message('pending_review'), prefs({ autoSend: true }))).toEqual({ allowed: true })
  })

  it('allows an explicitly approved message', () => {
    expect(canSendNow(message('approved'), prefs())).toEqual({ allowed: true })
  })

  it('approval outranks autoSend being off — an approved message is the human saying yes', () => {
    expect(canSendNow(message('approved'), prefs({ autoSend: false })).allowed).toBe(true)
  })

  it('never sends the same message twice', () => {
    const gate = canSendNow(message('sent', { sent_at: '2026-07-02T10:00:00.000Z' }), prefs({ autoSend: true }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('already sent')
  })

  it.each(['skipped', 'failed'] as const)('refuses to send a %s message', (status) => {
    const gate = canSendNow(message(status), prefs({ autoSend: true }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe(`message is ${status}`)
  })

  it('fails CLOSED on an unrecognised status rather than falling through to allowed', () => {
    // A status added to the DB but not to this switch must not become sendable
    // by omission. The cast is the point of the test.
    const gate = canSendNow(message('queued' as OutreachStatus), prefs({ autoSend: true }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/unexpected status/i)
  })

  it('is the only decision-maker: no status other than approved or pending_review can ever send', () => {
    // Exhaustive sweep. If someone adds a status and forgets the gate, this
    // catches it regardless of which branch they forgot.
    const sendable = (['pending_review', 'approved', 'sent', 'failed', 'skipped'] as const).filter(
      (s) => canSendNow(message(s), prefs({ autoSend: true })).allowed
    )
    expect(sendable).toEqual(['pending_review', 'approved'])
  })

  it('accepts an explicit human approval arriving with the send request', () => {
    // The atomic path: the approval IS the argument, so nothing is persisted
    // as 'approved' before the send succeeds.
    expect(
      canSendNow(message('pending_review'), prefs({ autoSend: false }), { humanApproved: true })
    ).toEqual({ allowed: true })
  })

  it('an in-request approval does NOT unlock a status that is otherwise closed', () => {
    // humanApproved must satisfy the approval requirement only — it is not a
    // master key. Re-sending something already sent, or reviving a skipped or
    // failed message, still has to go through the normal paths.
    for (const status of ['sent', 'skipped', 'failed'] as const) {
      expect(canSendNow(message(status), prefs(), { humanApproved: true }).allowed).toBe(false)
    }
    expect(
      canSendNow(message('queued' as OutreachStatus), prefs(), { humanApproved: true }).allowed
    ).toBe(false)
  })

  it('omitting the intent behaves exactly as before — the default is not an approval', () => {
    // Guards against the new third parameter accidentally becoming truthy by
    // default for the many existing call sites that pass only two arguments.
    expect(canSendNow(message('pending_review'), prefs()).allowed).toBe(false)
    expect(canSendNow(message('pending_review'), prefs(), {}).allowed).toBe(false)
    expect(
      canSendNow(message('pending_review'), prefs(), { humanApproved: false }).allowed
    ).toBe(false)
  })

  it('documents the arming hazard: a failed send that left the row approved stays sendable forever', () => {
    // This assertion is not describing desirable behaviour — it is pinning a
    // known hazard so the fix is verifiable. The queue UI approves a message
    // and THEN posts to the send route, so when the send leg fails on a
    // permission or daily-cap check the row is already 'approved'. From that
    // point this gate returns allowed unconditionally, with no second look at
    // whether the send ever actually happened — while the user has seen only a
    // red error toast and reasonably believes nothing was armed.
    //
    // Whoever fixes the ordering (make approve+send atomic, or roll the status
    // back to pending_review when the send leg fails) should come back here
    // and decide whether this test becomes an assertion about the new,
    // narrower contract.
    const armedByAFailedSend = message('approved', { error: 'daily cap reached (10/10)' })
    expect(canSendNow(armedByAFailedSend, prefs({ autoSend: false }))).toEqual({ allowed: true })
  })
})

describe('checkDailyCap — guardrail (2)', () => {
  it('allows a send below the cap', () => {
    expect(checkDailyCap(0, prefs({ dailyCap: 10 }))).toEqual({ allowed: true })
    expect(checkDailyCap(9, prefs({ dailyCap: 10 }))).toEqual({ allowed: true })
  })

  it('blocks AT the cap, not one past it', () => {
    // Off-by-one here means an 11th email on a cap of 10. The boundary is the
    // whole value of the guardrail.
    const gate = checkDailyCap(10, prefs({ dailyCap: 10 }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('daily cap reached (10/10)')
  })

  it('stays blocked once over the cap, and reports the real count', () => {
    const gate = checkDailyCap(14, prefs({ dailyCap: 10 }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('daily cap reached (14/10)')
  })

  it('honours the default cap of 10 without being told', () => {
    expect(checkDailyCap(9, prefs()).allowed).toBe(true)
    expect(checkDailyCap(10, prefs()).allowed).toBe(false)
  })

  it('a cap of 1 permits exactly one email', () => {
    expect(checkDailyCap(0, prefs({ dailyCap: 1 })).allowed).toBe(true)
    expect(checkDailyCap(1, prefs({ dailyCap: 1 })).allowed).toBe(false)
  })
})

describe('followUpWindowElapsed — guardrail (5), one polite follow-up', () => {
  const sentAt = '2026-07-01T09:00:00.000Z'
  const sentAtMs = new Date(sentAt).getTime()

  it('refuses to follow up on a message that was never sent', () => {
    // Chasing a reply to an email the recipient never received is the most
    // embarrassing failure this feature could produce.
    const gate = followUpWindowElapsed(null, prefs())
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('parent was never sent')
  })

  it('blocks before the window elapses and counts the days remaining', () => {
    const gate = followUpWindowElapsed(sentAt, prefs({ followUpDays: 5 }), new Date(sentAtMs + 2 * DAY_MS))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('follow-up window not elapsed (3d left)')
  })

  it('rounds days-left UP, so it never promises the window is closer than it is', () => {
    // 2.5 days elapsed of 5 → 2.5 remaining → must read 3d, not 2d.
    const gate = followUpWindowElapsed(sentAt, prefs({ followUpDays: 5 }), new Date(sentAtMs + 2.5 * DAY_MS))
    expect(gate.reason).toBe('follow-up window not elapsed (3d left)')
  })

  it('allows exactly at the boundary', () => {
    expect(followUpWindowElapsed(sentAt, prefs({ followUpDays: 5 }), new Date(sentAtMs + 5 * DAY_MS))).toEqual({
      allowed: true,
    })
  })

  it('blocks one millisecond before the boundary', () => {
    expect(
      followUpWindowElapsed(sentAt, prefs({ followUpDays: 5 }), new Date(sentAtMs + 5 * DAY_MS - 1)).allowed
    ).toBe(false)
  })

  it('allows well past the window', () => {
    expect(
      followUpWindowElapsed(sentAt, prefs({ followUpDays: 5 }), new Date(sentAtMs + 30 * DAY_MS)).allowed
    ).toBe(true)
  })

  it('honours the default of 5 days', () => {
    expect(followUpWindowElapsed(sentAt, prefs(), new Date(sentAtMs + 4 * DAY_MS)).allowed).toBe(false)
    expect(followUpWindowElapsed(sentAt, prefs(), new Date(sentAtMs + 5 * DAY_MS)).allowed).toBe(true)
  })

  it('fails closed when the parent timestamp is unparseable', () => {
    // Regression test for a real fail-open this file caught on its first run:
    // `new Date('not-a-date').getTime()` is NaN, every comparison against NaN
    // is false, so `elapsedMs < needMs` was false and the function fell
    // straight through to `{ allowed: true }` — a malformed sent_at was
    // instant permission to chase a reply. guardrails.ts now range-checks the
    // parsed value before doing arithmetic on it.
    const gate = followUpWindowElapsed('not-a-date', prefs(), new Date(sentAtMs))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('parent send time is unreadable')
  })

  it('does not treat a future-dated parent as eligible', () => {
    const gate = followUpWindowElapsed(sentAt, prefs({ followUpDays: 5 }), new Date(sentAtMs - 10 * DAY_MS))
    expect(gate.allowed).toBe(false)
  })
})
