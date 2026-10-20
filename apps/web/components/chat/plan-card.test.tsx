import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanCardView, planReducer, type PlanCardViewProps } from './plan-card'

const steps = [
  { id: 's1', title: 'Start an application: Engineer at Ramp' },
  { id: 's2', title: 'Write a cover letter for Engineer at Ramp' },
  { id: 's3', title: 'Research: Brex' },
  { id: 's4', title: 'Start an application: Designer at Brex' },
]
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

// No DOM here: the card is a function of its props, so the test walks the elements it returns and calls their click handlers.
function find(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, match, out))
  else if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>
    if (match(el)) out.push(el)
    find(el.props.children as ReactNode, match, out)
  }
  return out
}
function card(initial: string[], over: Partial<PlanCardViewProps> = {}) {
  const onGo = vi.fn()
  const onCancel = vi.fn()
  const state = { ids: initial }
  const props = () => ({ steps, ids: state.ids, onGo, onCancel, dispatch: (a: Parameters<typeof planReducer>[1]) => (state.ids = planReducer(state.ids, a)), ...over })
  const press = (label: string) => {
    const [button] = find(PlanCardView(props()), (el) => el.props['aria-label'] === label || (el.type === 'button' && el.props.children === label))
    if (!button) throw new Error(`no button ${label}`)
    ;(button.props.onClick as (() => void) | undefined)?.()
  }
  return { onGo, onCancel, state, press, markup: () => renderToStaticMarkup(<PlanCardView {...props()} />) }
}

describe('PlanCard', () => {
  it('sends the kept steps in order after a remove and a move', () => {
    const c = card(steps.map((s) => s.id))
    expect(text(c.markup())).toContain('Cello will do these 4 things once you agree.')
    c.press('Remove: Write a cover letter for Engineer at Ramp')
    c.press('Move up: Start an application: Designer at Brex')
    c.press('Move up: Start an application: Designer at Brex')
    c.press('Go ahead')
    expect(c.onGo).toHaveBeenCalledWith(['s4', 's1', 's3'])
  })

  it('cancels with nothing sent to run', () => {
    const c = card(steps.map((s) => s.id))
    c.press('Cancel')
    expect(c.onCancel).toHaveBeenCalledTimes(1)
    expect(c.onGo).not.toHaveBeenCalled()
  })

  it('cannot go ahead with nothing left and can put them back', () => {
    const c = card(['s1', 's2'], { steps: steps.slice(0, 2) })
    c.press('Remove: Start an application: Engineer at Ramp')
    c.press('Remove: Write a cover letter for Engineer at Ramp')
    expect(text(c.markup())).toContain('Nothing is left to do. Cancel, or put them back.')
    expect(c.markup()).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Go ahead<\/button>/)
    c.press('Go ahead')
    expect(c.onGo).not.toHaveBeenCalled()
    c.press('Put them back')
    expect(c.state.ids).toEqual(['s1', 's2'])
    c.press('Go ahead')
    expect(c.onGo).toHaveBeenCalledWith(['s1', 's2'])
  })

  it('names every control and keeps them 44px', () => {
    const c = card(['s1', 's2'])
    const out = c.markup()
    expect(out).toContain('role="group"')
    expect(out).toContain('aria-label="Plan"')
    expect(out).toContain('<ol')
    expect(text(out)).toContain('Remove any you do not want, or move them up or down.')
    for (const s of steps.slice(0, 2)) for (const verb of ['Move up', 'Move down', 'Remove']) expect(out).toContain(`aria-label="${verb}: ${s.title}"`)
    expect(out).toMatch(/aria-disabled="true"[^>]*aria-label="Move up: Start an application: Engineer at Ramp"|aria-label="Move up: Start an application: Engineer at Ramp"[^>]*aria-disabled="true"/)
    expect(out).toMatch(/aria-disabled="true"[^>]*aria-label="Move down: Write a cover letter for Engineer at Ramp"|aria-label="Move down: Write a cover letter for Engineer at Ramp"[^>]*aria-disabled="true"/)
    const buttons = out.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(8)
    for (const b of buttons) expect(b).toContain('min-h-11 min-w-11')
    expect(text(card(['s1']).markup())).toContain('Cello will do this once you agree.')
  })

  it('rests every control while busy', () => {
    const buttons = card(['s1', 's2'], { busy: true }).markup().match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b).toContain('disabled=""')
  })
})
