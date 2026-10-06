import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LogoTile, RoleTitle, logoSrc } from './role-tile'
import { RoleRow } from './role-row'

const LONG = 'Staff Machine Learning Engineer, Applied Research and Platform'

describe('RoleTitle', () => {
  it('sets the title and the company in the same class, so size, weight and colour match', () => {
    const html = renderToStaticMarkup(<RoleTitle id="r1" title="AI Engineer" company="Vantage Loom" companyId="c1" />)
    const names = html.match(/class="r-name[^"]*"/g) ?? []
    expect(names).toHaveLength(2)
    expect(html).toMatch(/<a [^>]*href="\/roles\/r1"[^>]*>AI Engineer<\/a>/)
    expect(html).toMatch(/<a [^>]*href="\/companies\/c1"[^>]*>Vantage Loom<\/a>/)
    expect(html.match(/<a [^>]*class="r-name[^"]*"[^>]*>/g)).toHaveLength(2)
  })

  it('renders a 60 character title whole, with no truncation', () => {
    expect(LONG.length).toBeGreaterThanOrEqual(60)
    const html = renderToStaticMarkup(<RoleTitle id="r2" title={LONG} company="Orchid Ledger" />)
    expect(html).toContain(LONG)
    expect(html).not.toMatch(/truncate|line-clamp|text-ellipsis/)
  })

  it('keeps the company plain when it has no page of its own', () => {
    const html = renderToStaticMarkup(<RoleTitle id="r3" title="Data Engineer" company="Petrichor Labs" />)
    expect(html).toContain('<span class="r-name">Petrichor Labs</span>')
  })
})

describe('LogoTile', () => {
  it('takes the favicon from the domain, and the employer domain from a job host', () => {
    expect(logoSrc('amazon.jobs')).toContain('domain=amazon.com')
    expect(logoSrc('www.stripe.com')).toContain('domain=stripe.com')
    expect(logoSrc(null)).toBeNull()
    expect(logoSrc('x.com', 'https://logo.example/x.png')).toBe('https://logo.example/x.png')
  })

  it('shows the initial in the same box when there is no logo', () => {
    const html = renderToStaticMarkup(<LogoTile name="Harbor Quill" size={56} />)
    expect(html).toContain('width:56px')
    expect(html).toContain('>H<')
    expect(html).not.toContain('<img')
  })

  it('opens Company from the logo', () => {
    const html = renderToStaticMarkup(<LogoTile name="Tessera Grid" domain="tesseragrid.example" companyId="c9" />)
    expect(html).toContain('href="/companies/c9"')
    expect(html).toContain('<img')
  })
})

describe('RoleRow', () => {
  it('leads with the tile, then the title and company at one weight, then the facts and actions', () => {
    const html = renderToStaticMarkup(
      <RoleRow id="r4" title="AI Engineer" company="Lumen Parcel" companyId="c4" meta="Remote, US" actions={<button>Interested</button>} />,
    )
    expect(html.indexOf('company page')).toBeLessThan(html.indexOf('AI Engineer'))
    expect(html.indexOf('AI Engineer')).toBeLessThan(html.indexOf('Remote, US'))
    expect(html.indexOf('Remote, US')).toBeLessThan(html.indexOf('Interested'))
    expect(html).not.toMatch(/truncate|line-clamp/)
  })
})
