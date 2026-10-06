import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApplicationMadeView } from './application-made'

describe('ApplicationMadeView', () => {
  it('lists what was made and the chats about the application, each chat opening in Chat', () => {
    const out = renderToStaticMarkup(
      <ApplicationMadeView made={[{ id: 'm1', type: 'comparison', title: 'Retell AI and Ramp', updated_at: '2026-10-05T10:00:00Z' }]} chats={[{ id: 'c1', title: 'Apply to Retell AI' }]} />
    )
    expect(out).toContain('Comparison: ')
    expect(out).toContain('Retell AI and Ramp')
    expect(out).toContain('href="/chat/c1"')
  })

  it('says nothing when there is nothing', () => {
    expect(renderToStaticMarkup(<ApplicationMadeView made={[]} chats={[]} />)).toBe('')
  })
})
