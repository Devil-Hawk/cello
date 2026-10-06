import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import NotFound from './not-found'
import { today } from '@/lib/routes'

describe('Not found', () => {
  const html = renderToStaticMarkup(<NotFound />)

  it('links to Today and says what to do', () => {
    expect(html).toContain(`href="${today.href}"`)
    expect(html).toContain('Go to Today')
  })

  it('uses no em dash or exclamation mark', () => {
    const text = html.replace(/<[^>]*>/g, ' ')
    expect(text).not.toMatch(/—|!/)
  })

  it('has one heading', () => {
    expect(html.match(/<h1/g)).toHaveLength(1)
  })
})
