// Fixture tests for the SSE adapter's interrupt-translation functions
// (extractInterruptValue / translateInterruptToWireEvent) — the exact
// pre-port `send({type:'paused'|'question', ...})` call sites this route
// used to write directly, now reconstructed from a graph interrupt() value.
//
// FIXTURES CAPTURED FROM THE PRE-PORT ROUTE, BEFORE IT CHANGED — the literal
// object shapes below are copied verbatim from the pre-port
// app/api/copilot/route.ts (git history: the commit immediately before the
// StateGraph port), specifically:
//   line ~1109: send({ type: 'question', step, questions })
//   line ~1139: send({ type: 'question', step, question, ...(options.length ? { options } : {}) })
//   line ~1244-1251: send({ type: 'paused', step, thought: thought ?? '', tool, args,
//     ...(submitReason ? { requiresConfirmation: true, reason: submitReason } : {}) })
// Every assertion below byte-compares against those exact shapes.

import { describe, expect, it } from 'vitest'
// These live in lib/graph/copilot.ts, not ./route — a Next.js route module
// may only export the App Router's own recognized names (see that file's
// header on the `next build` failure a bare `tsc --noEmit` never catches).
import { extractInterruptValue, translateInterruptToWireEvent, isPausedSentinel } from '@/lib/graph/copilot'
import type { MessageRow } from '@/lib/harness/copilot-store'

describe('extractInterruptValue', () => {
  it('reads the value off a real .invoke()-shaped result ({...values, __interrupt__:[{id,value}]})', () => {
    const result = { messages: [], __interrupt__: [{ id: 'abc', value: { kind: 'confirm', step: 2 } }] }
    expect(extractInterruptValue(result)).toEqual({ kind: 'confirm', step: 2 })
  })

  it('reads the value off a real .stream()-shaped terminal chunk ({__interrupt__:[...]} alone)', () => {
    const chunk = { __interrupt__: [{ id: 'xyz', value: { kind: 'ask', step: 0, question: 'which one?' } }] }
    expect(extractInterruptValue(chunk)).toEqual({ kind: 'ask', step: 0, question: 'which one?' })
  })

  it('takes the LAST interrupt when several are present (this codebase only ever raises one per node, but the reader stays honest about the shape)', () => {
    const result = { __interrupt__: [{ id: '1', value: { kind: 'first' } }, { id: '2', value: { kind: 'second' } }] }
    expect(extractInterruptValue(result)).toEqual({ kind: 'second' })
  })

  it('returns null for a plain completed-turn result with no __interrupt__ key', () => {
    expect(extractInterruptValue({ messages: [], trace: [] })).toBeNull()
  })

  it('returns null for null/non-object input', () => {
    expect(extractInterruptValue(null)).toBeNull()
    expect(extractInterruptValue(undefined)).toBeNull()
    expect(extractInterruptValue('nope')).toBeNull()
  })
})

describe('translateInterruptToWireEvent — byte-identical to the pre-port route.ts send() calls', () => {
  it('kind:"confirm" (the unconditional submit/send guard) -> {type:"paused",...,requiresConfirmation:true,reason}', () => {
    const value = {
      kind: 'confirm',
      step: 3,
      tool: 'trigger_run',
      args: { goal: 'submit application to Acme' },
      thought: 'the user asked to apply',
      reason: '"trigger_run" looks like it would submit an application or send a message to a real person — that always needs your explicit go-ahead.',
    }
    expect(translateInterruptToWireEvent(value)).toEqual({
      type: 'paused',
      step: 3,
      thought: 'the user asked to apply',
      tool: 'trigger_run',
      args: { goal: 'submit application to Acme' },
      requiresConfirmation: true,
      reason: value.reason,
    })
  })

  it('kind:"review" (plain thinkingMode:review pause) -> {type:"paused",...} with NO requiresConfirmation/reason', () => {
    const value = { kind: 'review', step: 1, tool: 'score_jobs', args: { jobIds: ['a', 'b'] }, thought: 'about to score' }
    expect(translateInterruptToWireEvent(value)).toEqual({
      type: 'paused',
      step: 1,
      thought: 'about to score',
      tool: 'score_jobs',
      args: { jobIds: ['a', 'b'] },
    })
  })

  it('kind:"review" with no thought -> thought defaults to "" (pre-port: `thought: thought ?? \'\'`)', () => {
    const value = { kind: 'review', step: 0, tool: 'source_jobs', args: {} }
    expect(translateInterruptToWireEvent(value)).toEqual({ type: 'paused', step: 0, thought: '', tool: 'source_jobs', args: {} })
  })

  it('kind:"ask" (legacy single question, with options) -> {type:"question",step,question,options}', () => {
    const value = { kind: 'ask', step: 5, question: 'Which company should I focus on?', options: [{ label: 'Acme' }, { label: 'Globex', detail: 'the bigger one' }] }
    expect(translateInterruptToWireEvent(value)).toEqual({
      type: 'question',
      step: 5,
      question: 'Which company should I focus on?',
      options: [{ label: 'Acme' }, { label: 'Globex', detail: 'the bigger one' }],
    })
  })

  it('kind:"ask" with no options -> the "options" key is OMITTED entirely (pre-port: `...(options.length ? { options } : {})`)', () => {
    const value = { kind: 'ask', step: 5, question: 'What next?', options: [] }
    const event = translateInterruptToWireEvent(value)
    expect(event).toEqual({ type: 'question', step: 5, question: 'What next?' })
    expect(event).not.toHaveProperty('options')
  })

  it('kind:"ask_form" (structured multi-question form) -> {type:"question",step,questions} — NOT "question"/"options"', () => {
    const questions = [{ header: 'Roles', question: 'Which roles?', multiSelect: true, options: [{ label: 'Backend' }, { label: 'Infra' }] }]
    const event = translateInterruptToWireEvent({ kind: 'ask_form', step: 2, questions })
    expect(event).toEqual({ type: 'question', step: 2, questions })
    expect(event).not.toHaveProperty('question')
    expect(event).not.toHaveProperty('options')
  })

  it('kind:"next_turn" (the between-turn boundary) is not client-visible — returns null', () => {
    expect(translateInterruptToWireEvent({ kind: 'next_turn' })).toBeNull()
  })

  it('an unrecognized/absent kind returns null rather than guessing', () => {
    expect(translateInterruptToWireEvent({ kind: 'something_new' })).toBeNull()
    expect(translateInterruptToWireEvent(null)).toBeNull()
    expect(translateInterruptToWireEvent('nope')).toBeNull()
  })
})

describe('isPausedSentinel — legacy GET read-filter (spec item 3: "one release")', () => {
  const base: MessageRow = { id: '1', conversation_id: 'c', user_id: 'u', role: 'assistant', content: '', trace: null, created_at: '' }

  it('a pre-port paused sentinel (trace ending in status:"paused") is hidden', () => {
    expect(isPausedSentinel({ ...base, trace: [{ status: 'ok' }, { status: 'paused' }] })).toBe(true)
  })

  it('a normal completed-turn message (trace ending in status:"ok") is not hidden', () => {
    expect(isPausedSentinel({ ...base, trace: [{ status: 'ok' }] })).toBe(false)
  })

  it('a user message is never treated as a sentinel', () => {
    expect(isPausedSentinel({ ...base, role: 'user', trace: [{ status: 'paused' }] })).toBe(false)
  })

  it('a message with no trace is not a sentinel', () => {
    expect(isPausedSentinel({ ...base, trace: null })).toBe(false)
    expect(isPausedSentinel({ ...base, trace: [] })).toBe(false)
  })
})
