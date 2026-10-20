import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Disclosure } from '@/lib/chat/disclosure'
import { modelWords, SourcesAndTools } from './sources-and-tools'

const d: Disclosure = {
  ran: null,
  tools: [{ label: 'Find roles' }],
  workers: [
    { title: 'Writing a message', status: 'failed', reads: 0 },
    { title: 'Researching Ramp', status: 'done', reads: 3 },
  ],
  sources: [{ title: 'Careers', host: 'ramp.com' }],
  seconds: 41,
  costUsd: 0,
}

describe('SourcesAndTools', () => {
  it('says each task\'s state in plain words, as the task block does', () => {
    const out = renderToStaticMarkup(<SourcesAndTools d={d} />)
    expect(out).toContain('Writing a message (Could not finish); Researching Ramp (Done, 3 read)')
    expect(out).not.toMatch(/\((failed|done|working)[,)]/)
    expect(out).toContain('1 source, 1 tool, 2 tasks. 0:41. Free.')
    expect(modelWords(null)).toBe('None. Code answered this.')
  })

  it('names every role that ran with its model and effort, and a step-down', () => {
    const chat = { role: 'chat' as const, rung: 'R3' as const, model: 'google/gemma-4-31b-it:free', effort: 'low' as const }
    const writing = { role: 'writer' as const, rung: 'R3' as const, model: 'laguna/laguna-s-2.1:free', effort: 'none' as const, steppedDown: { wanted: { rung: 'R3' as const, model: 'qwen/qwen3:free', effort: 'none' as const }, why: 'model' as const } }
    expect(modelWords(chat, [chat])).toBe('gemma-4-31b-it, Light')
    expect(modelWords(chat, [chat, writing])).toBe('Chat: gemma-4-31b-it, Light. Writing: laguna-s-2.1, Off (qwen3 did not answer).')
    expect(modelWords(null, [])).toBe('None. Code answered this.')
  })

  it('says the mode that ran and why, from the disclosure, and nothing on an older turn without one', () => {
    expect(renderToStaticMarkup(<SourcesAndTools d={d} />)).not.toContain('>Mode<')
    const out = renderToStaticMarkup(<SourcesAndTools d={{ ...d, mode: { mode: 'ask', why: 'keyword', blocked: 'send_for_me_off' } }} />)
    expect(out).toContain('>Mode<')
    expect(out).toContain('Ask first. Hands-off needs Send for me on.')
  })

  it('names the servers it could not reach, and says nothing when there were none', () => {
    expect(renderToStaticMarkup(<SourcesAndTools d={d} />)).not.toContain('Could not reach')
    expect(renderToStaticMarkup(<SourcesAndTools d={{ ...d, unreached: [] } as Disclosure} />)).not.toContain('Could not reach')
    const out = renderToStaticMarkup(<SourcesAndTools d={{ ...d, unreached: ['notes', 'mail'] } as Disclosure} />).replace(/<!-- -->/g, '')
    expect(out).toContain('Could not reach')
    expect(out).toContain('notes, mail')
  })
})
