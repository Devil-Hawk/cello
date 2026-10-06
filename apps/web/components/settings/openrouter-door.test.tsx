import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DOOR_FAILED, DOOR_LABEL, OpenRouterDoor, doorStateFromQuery } from './openrouter-door'

describe('OpenRouterDoor', () => {
  it('is one link to the start of the round trip, with the return path', () => {
    const html = renderToStaticMarkup(<OpenRouterDoor />)
    expect(html).toContain('href="/api/auth/openrouter/start?return=%2Fwelcome"')
    expect(html).toContain(DOOR_LABEL)
    expect(renderToStaticMarkup(<OpenRouterDoor returnTo="/settings" />)).toContain('return=%2Fsettings')
  })

  it('reads the outcome from the address', () => {
    expect(doorStateFromQuery('?models=failed')).toBe('failed')
    expect(doorStateFromQuery('?models=free')).toBe('free')
    expect(doorStateFromQuery('?models=other')).toBe('idle')
    expect(doorStateFromQuery('')).toBe('idle')
  })

  it('says what went wrong in the words of 4.3', () => {
    expect(DOOR_FAILED).toBe('That key did not work. OpenRouter keys start with sk-or-.')
  })
})
