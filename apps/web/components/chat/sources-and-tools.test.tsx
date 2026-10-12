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
})
