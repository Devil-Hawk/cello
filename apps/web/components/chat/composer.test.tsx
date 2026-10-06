import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer, type ComposerProps } from './composer'

const noop = () => undefined
const html = (over: Partial<ComposerProps> = {}) => renderToStaticMarkup(<Composer value="" onChange={noop} onSend={noop} onStop={noop} running={false} {...over} />)

describe('Composer', () => {
  it('sends only when there are typed words, and not while a turn runs', () => {
    expect(html()).toMatch(/aria-label="Send"[^>]*disabled=""/)
    expect(html({ value: 'Compare these' })).not.toMatch(/aria-label="Send"[^>]*disabled=""/)
    expect(html({ value: '   ' })).toMatch(/aria-label="Send"[^>]*disabled=""/)
  })

  it('turns Send into Stop while a turn runs', () => {
    const out = html({ value: 'x', running: true })
    expect(out).toContain('aria-label="Stop"')
    expect(out).not.toContain('aria-label="Send"')
  })

  it('shows a quoted selection apart from the field, marked as Cello\'s earlier words, with Remove', () => {
    const out = html({ quoted: { text: 'Stop showing crypto roles.' } })
    expect(out).toContain('data-quoted')
    expect(out).toContain('Cello&#x27;s earlier words')
    expect(out).toContain('Stop showing crypto roles.')
    expect(out).toContain('aria-label="Remove the quote"')
    // The field itself stays empty: a quote is never typed.
    expect(out).toMatch(/<textarea[^>]*><\/textarea>/)
  })

  it('grows to 8 lines and no more, and gives a notice that stops sending', () => {
    expect(html({ value: 'a\n'.repeat(20) })).toContain('rows="8"')
    expect(html({ value: 'a' })).toContain('rows="1"')
    const blocked = html({ value: 'hello', notice: 'Chat needs a model. Every page and button works without one.' })
    expect(blocked).toContain('Chat needs a model.')
    expect(blocked).toMatch(/aria-label="Send"[^>]*disabled=""/)
  })
})
