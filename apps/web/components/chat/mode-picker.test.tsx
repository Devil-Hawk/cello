import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModePicker, modeSummary } from './mode-picker'

const noop = () => undefined

describe('ModePicker', () => {
  it('says why hands-off cannot run, and greys that choice', () => {
    const on = { sendForMe: true, paused: false, isDemo: false }
    const out = renderToStaticMarkup(<ModePicker chat={null} settings="ask" resolved={{ mode: 'ask', why: 'default' }} facts={on} onPick={noop} />)
    expect(out).toContain('Ask first')
    expect(out).toContain('Hands-off')
    expect(out).not.toContain('disabled=""')

    // Send for me off greys Hands-off even while Ask first is the choice, so a pick never lands on it
    const off = renderToStaticMarkup(<ModePicker chat={null} settings="ask" resolved={{ mode: 'ask', why: 'default' }} facts={{ ...on, sendForMe: false }} onPick={noop} />)
    expect(off).toContain('Needs Send for me on, under Settings.')
    expect((off.match(/disabled=""/g) ?? []).length).toBe(1)

    const blocked = renderToStaticMarkup(<ModePicker chat="hands_off" settings="ask" resolved={{ mode: 'ask', why: 'chat', blocked: 'send_for_me_off' }} facts={{ ...on, sendForMe: false }} onPick={noop} />)
    expect(blocked).toContain('Needs Send for me on, under Settings.')
    expect((blocked.match(/disabled=""/g) ?? []).length).toBe(1)
    expect(modeSummary({ mode: 'ask', why: 'chat', blocked: 'send_for_me_off' })).toBe('Ask first (Hands-off blocked)')
    expect(blocked).toContain('Use the Settings choice')
  })

  it('shows the mode that runs on the composer', () => {
    expect(modeSummary({ mode: 'hands_off', why: 'settings' })).toBe('Hands-off')
    const out = renderToStaticMarkup(<ModePicker chat={null} settings="hands_off" resolved={{ mode: 'hands_off', why: 'settings' }} facts={{ sendForMe: true, paused: false, isDemo: false }} onPick={noop} />)
    expect(out).toMatch(/<summary[^>]*>.*Hands-off/)
    expect(out).toContain('From Settings. A choice here is for this chat only.')
    expect(out).not.toContain('Use the Settings choice')
  })
})
