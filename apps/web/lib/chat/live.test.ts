import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { liveShows, liveText, nextLive } from './live'

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

describe('nextLive', () => {
  const live = { words: 'I will', tools: [{ label: 'Find roles', phase: 'start' as const }] }

  it('grows the words and moves a tool from start to end', () => {
    expect(nextLive(live, { type: 'words', text: 'I will look' }, false)?.words).toBe('I will look')
    expect(nextLive(live, { type: 'tool', label: 'Find roles', phase: 'end' }, false)?.tools).toEqual([{ label: 'Find roles', phase: 'end' }])
  })

  it('holds still once Stop is pressed, so a call still in flight adds nothing', () => {
    expect(nextLive(live, { type: 'words', text: 'I will look it up now' }, true)).toBe(live)
    expect(nextLive(live, { type: 'tool', label: 'Read a role', phase: 'start' }, true)).toBe(live)
  })
})

describe('liveShows', () => {
  const live = { words: 'Some words', tools: [] }

  it('shows while the newest turn is the person\'s, or their line is not stored yet', () => {
    expect(liveShows(live, 'person', false)).toBe(true)
    expect(liveShows(live, undefined, false)).toBe(true)
    expect(liveShows(live, 'cello', true)).toBe(true)
  })

  it('hides the moment the stored answer is the newest turn, so both are never on the page', () => {
    expect(liveShows(live, 'cello', false)).toBe(false)
  })

  it('shows nothing with no words and no tools', () => {
    expect(liveShows({ words: '', tools: [] }, 'person', false)).toBe(false)
    expect(liveShows(null, 'person', false)).toBe(false)
  })
})

describe('chat streaming source', () => {
  it('writes the live words through the Markdown renderer, not a plain paragraph', () => {
    const source = readFileSync(new URL('../../components/chat/chat-view.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<Markdown content={live.words} />')
    expect(source).not.toContain('{live.words}</p>')
  })

  it('keeps the live block until the stored answer has loaded', () => {
    const source = readFileSync(new URL('../../components/chat/chat-view.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/event\.type === 'answer'[\s\S]{0,200}loadPage\(\)\.then\(\(\) => setLive\(null\)\)/)
  })
})
