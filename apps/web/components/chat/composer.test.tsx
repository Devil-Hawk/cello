import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer, keyAction, type ComposerProps } from './composer'

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

  it('rests the Stop key once Stop has been pressed', () => {
    expect(html({ value: 'x', running: true })).not.toMatch(/aria-label="Stop"[^>]*aria-disabled="/)
    expect(html({ value: 'x', running: true, stopping: true })).toMatch(/aria-label="Stop"[^>]*aria-disabled="true"/)
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

  it('shows the status line under the controls, outside anything clickable', () => {
    const out = html({ status: 'Your last answer came from laguna-s-2.1: gemma did not answer.' })
    expect(out).toMatch(/<\/div><p class="mt-1 px-1 text-caption text-muted-foreground">Your last answer came from laguna-s-2.1: gemma did not answer.<\/p><\/div>$/)
    expect(html()).not.toContain('mt-1 px-1 text-caption')
  })

  it('draws no microphone until the browser is known to have speech to text', () => {
    expect(html()).not.toContain('Dictate')
  })

  it('grows to 8 lines and no more, and gives a notice that stops sending', () => {
    expect(html({ value: 'a\n'.repeat(20) })).toContain('rows="8"')
    expect(html({ value: 'a' })).toContain('rows="1"')
    const blocked = html({ value: 'hello', notice: 'Chat needs a model. Every page and button works without one.' })
    expect(blocked).toContain('Chat needs a model.')
    expect(blocked).toMatch(/aria-label="Send"[^>]*disabled=""/)
  })

  it('Enter sends and Shift+Enter breaks the line in the field; Escape stops a running turn from the field or the page, not from another field', () => {
    expect(keyAction({ key: 'Enter' }, 'field', false)).toBe('send')
    expect(keyAction({ key: 'Enter', shiftKey: true }, 'field', false)).toBeNull()
    expect(keyAction({ key: 'Enter', isComposing: true }, 'field', false)).toBeNull()
    expect(keyAction({ key: 'Enter' }, 'page', false)).toBeNull()
    expect(keyAction({ key: 'Escape' }, 'field', true)).toBe('stop')
    expect(keyAction({ key: 'Escape' }, 'page', true)).toBe('stop')
    expect(keyAction({ key: 'Escape' }, 'other-field', true)).toBeNull()
    expect(keyAction({ key: 'Escape' }, 'field', false)).toBeNull()
  })
})
