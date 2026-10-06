import { describe, expect, it } from 'vitest'
import { actorWords, DOORS } from './actors'
import { LEGAL_MOVES, canMove, statusSentence, type MoveFrom } from './states'
import { APPLICATION_STATES, NEEDS_REASONS, STOP_CAUSES, type ApplicationState } from './types'

const FROM: MoveFrom[] = ['none', ...APPLICATION_STATES]

describe('the table of moves', () => {
  it('names every state and only states', () => {
    expect(Object.keys(LEGAL_MOVES).sort()).toEqual([...FROM].sort())
    for (const tos of Object.values(LEGAL_MOVES)) for (const to of tos) expect(APPLICATION_STATES).toContain(to)
  })

  // every pair, so a move added to or dropped from the table is a visible change in this file
  const LEGAL: Array<[MoveFrom, ApplicationState]> = [
    ['none', 'preparing'], ['none', 'needs_you'], ['none', 'sent'], ['none', 'skipped'],
    ['preparing', 'preparing'], ['preparing', 'needs_you'], ['preparing', 'scheduled'], ['preparing', 'ready'],
    ['preparing', 'not_sent'], ['preparing', 'paused'], ['preparing', 'skipped'], ['preparing', 'sent'],
    ['needs_you', 'preparing'], ['needs_you', 'ready'], ['needs_you', 'sent'], ['needs_you', 'skipped'], ['needs_you', 'paused'],
    ['scheduled', 'preparing'], ['scheduled', 'paused'], ['scheduled', 'skipped'], ['scheduled', 'not_sent'],
    ['ready', 'applying'], ['ready', 'sent'], ['ready', 'skipped'], ['ready', 'paused'], ['ready', 'preparing'], ['ready', 'needs_you'],
    ['applying', 'applying'], ['applying', 'sent'], ['applying', 'needs_you'], ['applying', 'ready'],
    ['sent', 'confirmed'], ['sent', 'ready'],
    ['not_sent', 'preparing'], ['not_sent', 'skipped'],
    ['skipped', 'preparing'],
    ['paused', 'preparing'], ['paused', 'needs_you'], ['paused', 'scheduled'], ['paused', 'ready'],
  ]

  it('allows each listed move and refuses every other', () => {
    for (const from of FROM) {
      for (const to of APPLICATION_STATES) {
        const listed = LEGAL.some(([f, t]) => f === from && t === to)
        expect(canMove(from, to), `${from} to ${to}`).toBe(listed)
      }
    }
  })

  it('has no way back from confirmed, and no move into none', () => {
    expect(LEGAL_MOVES.confirmed).toEqual([])
    for (const tos of Object.values(LEGAL_MOVES)) expect(tos as readonly string[]).not.toContain('none')
  })

  it('reaches every state from a row with no state', () => {
    const seen = new Set<MoveFrom>(['none'])
    const queue: MoveFrom[] = ['none']
    while (queue.length) for (const to of LEGAL_MOVES[queue.shift() as MoveFrom]) if (!seen.has(to)) (seen.add(to), queue.push(to))
    expect([...seen].sort()).toEqual([...FROM].sort())
  })
})

describe('the sentences', () => {
  const row = (over: Partial<Parameters<typeof statusSentence>[0]>) => ({ state: null, step: null, needsReason: null, needsDetail: null, ...over })
  const all: string[] = []
  for (const state of APPLICATION_STATES) {
    all.push(statusSentence(row({ state }), 'Stripe'))
    all.push(statusSentence(row({ state, step: 'Tailoring your resume.' }), 'Stripe'))
  }
  for (const needsReason of NEEDS_REASONS) all.push(statusSentence(row({ state: 'needs_you', needsReason }), 'Stripe'))
  for (const cause of STOP_CAUSES) all.push(statusSentence(row({ state: 'needs_you', needsReason: 'your_turn', needsDetail: { cause } }), 'Amazon'))

  it('says the right thing for the cases the blueprint names', () => {
    expect(statusSentence(row({ state: 'preparing', step: 'Tailoring your resume' }), 'Stripe')).toBe('Cello is preparing this: tailoring your resume.')
    expect(statusSentence(row({ state: 'needs_you', needsReason: 'your_turn', needsDetail: { cause: 'account' } }), 'Amazon')).toBe(
      "Needs you: Amazon needs an account. Sign in on Amazon's site first, then click Fill on each page.",
    )
    expect(statusSentence(row({ state: 'needs_you', needsReason: 'duplicate', needsDetail: { sent_on: 'Sep 12' } }), 'Stripe')).toBe('Needs you: you may have applied on Sep 12.')
    expect(statusSentence(row({ state: 'ready' }), 'Stripe', 'You did not choose this one. Let Cello send this?')).toBe(
      'Needs you: ready to send. You did not choose this one. Let Cello send this?',
    )
    expect(statusSentence(row({ state: 'confirmed' }), 'Stripe')).toBe('Stripe confirmed it.')
    expect(statusSentence(row({ state: null }), 'Stripe')).toBe('')
  })

  it('reads as the voice requires: sentence case, no internal names, no em dash, no exclamation, never the retired word', () => {
    for (const s of all) {
      expect(s).not.toMatch(/—|!|needs_you|your_turn|check_sent|approve_resume|wait_computer/i)
      if (s) expect(s).toMatch(/^[A-Z]/)
      expect(s).not.toMatch(/\.\./)
    }
  })

  it('names the cause of every stop', () => {
    const sentences = STOP_CAUSES.map((cause) => statusSentence(row({ state: 'needs_you', needsReason: 'your_turn', needsDetail: { cause } }), 'Amazon'))
    expect(new Set(sentences).size).toBe(STOP_CAUSES.length)
  })
})

describe('who made a move', () => {
  it('maps each door to the actor and channel the code path sets', () => {
    expect(DOORS.session).toEqual({ actor: 'person', channel: 'session' })
    expect(DOORS.chat).toEqual({ actor: 'cello', channel: 'chat' })
    expect(DOORS.assistant).toEqual({ actor: 'cello', channel: 'assistant' })
    expect(DOORS.extension).toEqual({ actor: 'extension', channel: 'extension' })
  })

  it('says it in the timeline words', () => {
    expect(actorWords('person', 'session')).toBe('You')
    expect(actorWords('schedule', 'routine')).toBe('Cello')
    expect(actorWords('schedule', 'routine', 'instruction')).toBe('Your instruction')
    expect(actorWords('rule', 'routine')).toBe('Your rule')
    expect(actorWords('cello', 'chat')).toBe('Cello, from Chat')
    expect(actorWords('cello', 'assistant')).toBe('Your assistant')
    expect(actorWords('cello', 'agent', 'Claude Desktop')).toBe('Another agent: Claude Desktop')
    expect(actorWords('extension', 'extension')).toBe('Your browser')
    expect(actorWords('email', 'inbox')).toBe('From your email')
  })
})
