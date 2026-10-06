import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// The quick chat in the shell asks for the router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => '/' }))

import { Shell } from './shell'

const user = { email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }

function render(pathname: string, needsYou?: number): string {
  return renderToStaticMarkup(
    <Shell pathname={pathname} user={user} onSignOut={() => undefined} needsYou={needsYou}>
      <p>page</p>
    </Shell>,
  )
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('the bar', () => {
  it('marks only the current page with aria-current', () => {
    const html = render('/roles')
    const bar = html.slice(html.indexOf('aria-label="Primary"'), html.indexOf('</nav>', html.indexOf('aria-label="Primary"')))
    expect(bar.match(/aria-current="page"/g)).toHaveLength(1)
    expect(bar).toMatch(/aria-current="page"[^>]*>Roles|>Roles<\/a>/)
    expect(bar.indexOf('Roles')).toBeLessThan(bar.indexOf('Companies'))
  })

  it('keeps the same key standing inside a page, and none on an unknown address', () => {
    const inside = render('/companies/abc')
    expect(inside).toContain('aria-current="page"')
    const none = render('/settings')
    const primary = none.slice(none.indexOf('aria-label="Primary"'), none.indexOf('</nav>', none.indexOf('aria-label="Primary"')))
    expect(primary).not.toContain('aria-current')
  })

  it('shows Today with its copper numeral only when there is a count', () => {
    expect(textOf(render('/dashboard', 3))).toContain('Today 3')
    expect(textOf(render('/dashboard'))).not.toMatch(/Today \d/)
  })

  it('has five phone tabs', () => {
    const html = render('/roles')
    const tabs = html.slice(html.indexOf('aria-label="Bottom navigation"'))
    expect(tabs.match(/<a /g)).toHaveLength(5)
  })

  it('names no retired page', () => {
    const text = textOf(render('/roles'))
    for (const word of ['Copilot', 'Opportunities', 'dashboard', 'Dashboard']) expect(text).not.toContain(word)
  })

  it('has a skip link to the main content, and a main landmark', () => {
    const html = render('/roles')
    expect(html).toContain('href="#main-content"')
    expect(html).toContain('id="main-content"')
  })
})
