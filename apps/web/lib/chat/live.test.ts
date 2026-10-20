import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { liveText } from './live'

describe('liveText', () => {
  it('reads plain text from a message', () => {
    expect(liveText({ content: 'Words as they arrive.' })).toBe('Words as they arrive.')
  })

  it('reads the written parts from half-written structured answer JSON', () => {
    expect(liveText({ content: '{"parts":[{"about":[],"text":"First sentence"},{"about":[],"text":"Second' })).toBe('First sentence\nSecond')
  })

  it('joins text blocks without exposing tool arguments', () => {
    expect(liveText({ content: [{ type: 'text', text: 'One' }, { type: 'text', text: ' two' }], tool_calls: [{ args: { secret: 'do not show' } }] })).toBe('One two')
  })
})

describe('liveText links', () => {
  it('shows a link to a thing as its words, finished or half written', () => {
    expect(liveText({ content: 'The [Datadog role](cello:role/abc-1) fits.' })).toBe('The Datadog role fits.')
    expect(liveText({ content: 'The [Datadog role](cello:role/ab' })).toBe('The [Datadog role')
  })
})

describe('chat streaming source', () => {
  it('does not use a timer poll', () => {
    const source = readFileSync(new URL('../../components/chat/chat-view.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('setInterval(')
  })
})
