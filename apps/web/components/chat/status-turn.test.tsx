import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusTurn } from './status-turn'

const line = { eventId: 'e1', sentence: 'Cello is filling the form for Vantage Loom.', applicationId: 'a1', state: 'applying', at: '2026-10-05T10:00:00Z', approval: null }

describe('StatusTurn', () => {
  it('shows the event\'s sentence and a way to open the application', () => {
    const out = renderToStaticMarkup(<StatusTurn line={line} />)
    expect(out).toContain('Cello is filling the form for Vantage Loom.')
    expect(out).toContain('href="/pipeline"')
    expect(out).toContain('>Open<')
  })

  it('shows nothing when the event could not be read', () => {
    expect(renderToStaticMarkup(<StatusTurn line={undefined} />)).toBe('')
  })
})
