import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), usePathname: () => '/companies' }))
vi.mock('@/app/(app)/companies/actions', () => ({
  setFollow: async () => ({ ok: true, changed: 1 }),
  takeCheck: async () => ({ ok: true }),
  followAnyway: async () => ({ ok: true, companyId: 'c', name: 'Retell' }),
  findCompaniesAction: async () => ({ employers: [], notChecked: [] }),
}))

import { AddOrFind } from './add-or-find'
import { CompaniesView } from './companies-view'
import { FIXTURE_NOW, fixtureCheck, fixtureData, fixtureItem } from './fixtures'
import {
  DEFAULT_QUERY,
  NO_FILTERS,
  addOutcome,
  addReducer,
  cannotReadLine,
  classifyInput,
  companiesHref,
  failLine,
  filterCount,
  forYouLine,
  loadingLine,
  parseCompaniesQuery,
  parseCursor,
  readingLine,
  tabLabel,
  verifyingLine,
  type AddResponse,
  type CompaniesQuery,
} from './logic'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')
interface Opts {
  sponsor?: boolean
  cannot?: boolean
  types?: boolean
  loading?: boolean
  failed?: boolean
}
const view = (n: number, query: Partial<CompaniesQuery> = {}, o: Opts = {}) => {
  const q = { ...DEFAULT_QUERY, ...query }
  return renderToStaticMarkup(<CompaniesView query={q} {...fixtureData({ n, query: q, ...o })} now={FIXTURE_NOW} />)
}

describe('the address', () => {
  it('has no parameters for the default view and keeps every choice in the address', () => {
    expect(companiesHref(DEFAULT_QUERY)).toBe('/companies')
    const id = '00000000-0000-4000-8000-000000000007'
    const q = parseCompaniesQuery({ tab: 'following', type: 'ai-engineer', cannot: '1', pinned: '1', h1b: '1', focus: id, after: JSON.stringify([1, 0, -2, 'alpha', id]) })
    expect(q).toMatchObject({ tab: 'following', type: 'ai-engineer', cannot: true, pinned: true, h1b: true, focus: id, after: [1, 0, -2, 'alpha', id] })
    expect(parseCompaniesQuery(Object.fromEntries(new URL(`http://x${companiesHref(q)}`).searchParams))).toEqual(q)
    expect(filterCount(q)).toBe(4)
    expect(companiesHref(q, NO_FILTERS)).toBe(`/companies?tab=following&focus=${id}`)
  })

  it('takes a page key only in the shape SQL makes for that tab, and falls back for anything else', () => {
    const id = '00000000-0000-4000-8000-000000000007'
    expect(parseCursor(JSON.stringify(['alpha works', id]), 'all')).toEqual(['alpha works', id])
    expect(parseCursor(JSON.stringify(['alpha works', id]), 'hiring')).toBeNull()
    expect(parseCursor(JSON.stringify([1, 0, 0, 'a', 'not-a-uuid']), 'hiring')).toBeNull()
    expect(parseCursor('{"x":1}', 'all')).toBeNull()
    expect(parseCursor('not json', 'all')).toBeNull()
    expect(parseCompaniesQuery({ tab: 'x', type: 'DROP TABLE', focus: 'nope', after: '[1]' })).toEqual(DEFAULT_QUERY)
  })
})

describe('the tabs', () => {
  it('show the counts they were given, and no number for All until the sweep has stored one', () => {
    const counts = { hiring: 213, following: 12, all: 38406 }
    expect(tabLabel('hiring', counts)).toBe('Hiring for you 213')
    expect(tabLabel('all', counts)).toBe('All 38,406')
    expect(tabLabel('all', { ...counts, all: null })).toBe('All')
  })

  it('put the counts from SQL on the page, and the tab in the address', () => {
    const html = view(3, { tab: 'following' })
    expect(text(html)).toContain('Hiring for you 213')
    expect(text(html)).toContain('Following 3')
    expect(text(html)).toContain('All 38,406')
    expect(html).toContain('href="/companies?tab=all"')
  })
})

describe('a page of rows', () => {
  it('shows 0, 1, 50 and 51 rows with a Next only past 50, carrying the last shown key', () => {
    expect(view(0)).not.toContain('>Next<')
    expect(view(1)).not.toContain('>Next<')
    const fifty = view(50)
    expect(fifty).not.toContain('>Next<')
    expect(fifty.match(/class="r-name hover:underline"/g)).toHaveLength(50)
    const q = { ...DEFAULT_QUERY, tab: 'hiring' as const }
    const data = fixtureData({ n: 51, query: q })
    expect(data.items).toHaveLength(50)
    const html = view(51)
    expect(html).toContain('>Next<')
    expect(html).toContain(new URLSearchParams({ after: JSON.stringify(data.items[49].key) }).toString())
    expect(html).not.toContain('Fixture Employer 051')
  })

  it('pages All by (name, id) and takes the key back through the address', () => {
    const q = { ...DEFAULT_QUERY, tab: 'all' as const }
    const data = fixtureData({ n: 51, query: q })
    expect(data.next).toHaveLength(2)
    const href = companiesHref(q, { after: data.next })
    expect(parseCompaniesQuery(Object.fromEntries(new URL(`http://x${href}`).searchParams)).after).toEqual(data.next)
    expect(view(51, { tab: 'all' })).not.toContain('First page')
    expect(view(51, { tab: 'all', after: data.next })).toContain('First page')
  })

  it('says to choose role types for a person with none, while All still lists', () => {
    expect(text(view(0, {}, { types: false }))).toContain('Choose your role types to see who is hiring for you.')
    expect(text(view(3, { tab: 'all' }, { types: false }))).toContain('Fixture Employer 001')
  })

  it('says nothing is hiring for a person with types, with the check line and two ways on', () => {
    const t = text(view(0))
    expect(t).toContain('No employer has a role for you right now.')
    expect(t).toContain('Checked 3 hours ago. Next at 18:00 UTC.')
    expect(t).toContain('Edit your search')
    expect(t).toContain('See all companies')
  })

  it('tells how far the seed has come while candidates wait, and stops once none do', () => {
    expect(text(view(3, {}, { loading: true }))).toContain('Cello has checked 1,200 employers so far. The rest arrive as it reads them.')
    expect(loadingLine(38406, 0)).toBeNull()
    expect(text(view(3))).not.toContain('employers so far')
  })

  it('says it could not load, with a way to try again', () => {
    const t = text(view(0, {}, { failed: true }))
    expect(t).toContain('Could not load companies.')
    expect(t).toContain('Try again')
  })

  it('says no company matches when filters leave nothing', () => {
    expect(text(view(0, { type: 'ai-engineer' }))).toContain('No company matches these filters.')
  })
})

describe('a row', () => {
  it('shows the count, the split by type and of how many are open, from what it was given', () => {
    const line = forYouLine(fixtureItem(0))
    expect(line).toEqual({ head: '3 for you', split: 'AI Engineer 2, Forward Deployed Engineer 1', open: 'of 636 open' })
    const t = text(view(2))
    expect(t).toContain('3 for you')
    expect(t).toContain('AI Engineer 2, Forward Deployed Engineer 1')
    expect(t).toContain('of 636 open')
  })

  it('shows its reason and a link to the site for an employer it cannot read, and never a count or a 0', () => {
    const t = text(view(3, {}, { cannot: true }))
    expect(t).toContain('Cannot read: its job board is gone.')
    expect(t).toContain('Open their site')
    expect(forYouLine(fixtureItem(1, { cannotRead: 'no_board', forYou: null }))).toBeNull()
    expect(forYouLine(fixtureItem(1, { cannotRead: 'no_board', forYou: 0 }))).toBeNull()
    expect(cannotReadLine('weird_code')).toBe('Cannot read: Cello could not read its site.')
    expect(t).not.toContain('0 for you')
    expect(t).not.toContain('no_board')
  })

  it('reads the clock for a followed employer and says rotation for the rest, never a next time it does not hold', () => {
    const followed = fixtureItem(0)
    const other = fixtureItem(1)
    expect(readingLine(followed, fixtureCheck, FIXTURE_NOW)).toBe('Checked 3 hours ago. Next at 18:00 UTC.')
    expect(readingLine(other, fixtureCheck, FIXTURE_NOW)).toBe('Read in rotation. Last read 4 hours ago.')
    expect(readingLine(followed, { lastAt: null, nextAt: null, missed: 'Missed at 12:00. Cello is retrying.' }, FIXTURE_NOW)).toBe('Missed at 12:00. Cello is retrying.')
    expect(readingLine(followed, null, FIXTURE_NOW)).toBeNull()
    const html = text(view(6))
    // Rows 0 and 3 are followed; the other four are read in rotation.
    expect(html.match(/Next at/g)).toHaveLength(2)
    expect(html.match(/Read in rotation\./g)).toHaveLength(4)
  })

  it('offers Pin only on a followed row, and Follow on the rest', () => {
    const html = view(3)
    expect(html).toContain('aria-label="Unpin Fixture Employer 001"')
    expect(html).not.toContain('Pin Fixture Employer 002')
    expect(html).toContain('aria-label="Follow Fixture Employer 002"')
    expect(html).not.toContain('aria-label="Follow Fixture Employer 001"')
  })

  it('shows the filings line only for a person who needs sponsorship and an employer on the list', () => {
    expect(text(view(4))).not.toContain('Past H-1B filings')
    const t = text(view(4, {}, { sponsor: true }))
    expect(t.match(/Past H-1B filings/g)!.length).toBeGreaterThanOrEqual(2)
    expect(view(4)).not.toContain('name="h1b"')
    expect(view(4, {}, { sponsor: true })).toContain('name="h1b"')
  })

  it('opens its details from the address: up to five roles with type and posted, and three ways on', () => {
    const id = fixtureItem(0).id
    const html = view(3, { focus: id })
    const t = text(html)
    expect(t).toContain('Hide details')
    expect(t).toContain('Forward Deployed Engineer · Posted 3 days ago')
    expect(t).toContain('See all in Roles')
    expect(t).toContain('Open their careers site')
    expect(html).toContain('href="/roles?group=company&amp;company=')
    expect(html).toContain('href="/roles/10000000-0000-4000-8000-000000000001"')
    // Each title and the company share the one class, so neither is quieter than the other.
    expect(html.match(/<a [^>]*class="r-name hover:underline"[^>]*>AI Engineer</g)!.length).toBeGreaterThanOrEqual(1)
    expect(html).toContain('lg:hidden')
    expect(html).toContain('hidden lg:block')
  })

  it('opens the Company page from the name and the logo', () => {
    const html = view(1)
    expect(html).toContain(`href="/companies/${fixtureItem(0).id}"`)
  })
})

describe('Following', () => {
  it('has Check all now, Fix company names and, on a row, Check now and Stop following', () => {
    const t = text(view(3, { tab: 'following' }))
    expect(t).toContain('Check all now')
    expect(t).toContain('Fix company names')
    expect(t).toContain('Stop following')
    expect(t).toContain('Check now')
  })

  it('says what to do with nobody followed', () => {
    expect(text(view(0, { tab: 'following' }))).toContain('You do not follow a company yet.')
  })
})

describe('Add or find', () => {
  it('has the field the blueprint names', () => {
    const html = view(1)
    expect(html).toContain('placeholder="Name, or a careers page or job board link"')
    expect(html).toContain('aria-label="Add or find a company"')
  })

  it('takes a link for anything with a scheme, or a dot and a slash, and a name for the rest', () => {
    expect(classifyInput('r')).toEqual({ kind: 'none' })
    expect(classifyInput('  ')).toEqual({ kind: 'none' })
    expect(classifyInput('retell')).toEqual({ kind: 'name', text: 'retell' })
    expect(classifyInput('retellai.com')).toEqual({ kind: 'name', text: 'retellai.com' })
    expect(classifyInput('jobs.ashbyhq.com/retell-ai')).toEqual({ kind: 'link', text: 'jobs.ashbyhq.com/retell-ai' })
    expect(classifyInput('https://retellai.com')).toEqual({ kind: 'link', text: 'https://retellai.com' })
  })

  it('says what it is checking, with a guess when it has one', () => {
    expect(verifyingLine({ link: 'https://jobs.ashbyhq.com/retell-ai', name: 'Retell AI' })).toBe("Checking that jobs.ashbyhq.com/retell-ai is Retell AI's job site.")
    expect(verifyingLine({ link: 'https://jobs.ashbyhq.com/retell-ai' })).toBe('Checking jobs.ashbyhq.com/retell-ai.')
    expect(verifyingLine({ name: 'Retell AI', domain: 'retellai.com' })).toBe("Checking that retellai.com is Retell AI's job site.")
  })

  const employer = { employerId: 'e1', name: 'Retell AI', domain: 'retellai.com', logoUrl: null, openCount: 6 }

  it('ends Added with the row to open, and says so for an employer already followed', () => {
    const added = addOutcome({ ok: true, companyId: 'c1', already: false, employer })
    expect(added).toEqual({ kind: 'added', line: 'Following Retell AI. Cello is reading its site now.', actions: [{ kind: 'open', label: 'Open Retell AI', href: '/companies/e1' }] })
    const already = addOutcome({ ok: true, companyId: 'c1', already: true, employer })
    expect(already).toMatchObject({ kind: 'added', line: 'You already follow Retell AI.' })
    expect(already.kind === 'added' && already.actions[0]).toMatchObject({ kind: 'open', href: '/companies/e1' })
  })

  it('gives one sentence per reason, the limit and the demo lines, and never the code', () => {
    const ctx = { link: 'https://jobs.ashbyhq.com/retell-ai', name: 'Retell AI' }
    const reasons = ['not_linked', 'other_owner', 'stale', 'no_board', 'cannot_read', 'not_employer_site', 'bad_link', 'daily_limit', 'demo', 'not_found', 'not_saved'] as const
    const lines = reasons.map((r) => failLine(r, ctx))
    expect(new Set(lines).size).toBe(lines.length)
    for (const l of lines) expect(l).not.toMatch(/[a-z]+_[a-z]+/)
    expect(failLine('not_linked', ctx)).toBe("jobs.ashbyhq.com does not link to this board, so Cello cannot tell it is Retell AI's.")
    expect(failLine('daily_limit', ctx)).toBe('You have added 30 companies today. You can add more tomorrow.')
    expect(failLine('demo', ctx)).toBe('The demo cannot add companies. Sign in with your own account to add one.')
  })

  it("offers to follow the employer a failed check found, and to use the employer's own posting", () => {
    const res: AddResponse = { ok: false, reason: 'other_owner', offers: [{ kind: 'employer', name: 'Retell AI', employerId: 'e1' }, { kind: 'posting', name: 'Stripe', url: 'https://stripe.com/jobs/1' }] }
    const s = addOutcome(res, { link: 'https://x.example/jobs' })
    expect(s.kind === 'failed' && s.actions).toEqual([
      { kind: 'follow', label: 'Follow Retell AI', employerId: 'e1' },
      { kind: 'link', label: 'Use their own posting', link: 'https://stripe.com/jobs/1' },
    ])
  })

  it('offers Follow anyway and Open their site when the site could not be read, and a paste for no board', () => {
    const cannot = addOutcome({ ok: false, reason: 'cannot_read' }, { link: 'https://careers.example.com/jobs' })
    expect(cannot.kind === 'failed' && cannot.actions.map((a) => a.kind)).toEqual(['anyway', 'open'])
    expect(cannot.kind === 'failed' && cannot.line).toBe('Cello could not read their site.')
    const none = addOutcome({ ok: false, reason: 'no_board' }, {})
    expect(none.kind === 'failed' && none.actions).toEqual([{ kind: 'paste', label: 'Paste a link to one of their postings' }])
  })

  it('lets a result land only while its own check is on screen', () => {
    const verifying = addReducer({ kind: 'idle' }, { type: 'verify', line: 'Checking x.' })
    expect(verifying).toEqual({ kind: 'verifying', line: 'Checking x.' })
    const done = addOutcome({ ok: true, companyId: 'c', already: false, employer })
    expect(addReducer(verifying, { type: 'result', state: done })).toEqual(done)
    // Typing again resets, so the late answer is dropped.
    const reset = addReducer(verifying, { type: 'reset' })
    expect(addReducer(reset, { type: 'result', state: done })).toEqual({ kind: 'idle' })
  })

  it('draws each state with its buttons', () => {
    const verifying = renderToStaticMarkup(<AddOrFind initial={{ kind: 'verifying', line: "Checking that jobs.ashbyhq.com/retell-ai is Retell AI's job site." }} />)
    expect(verifying).toContain('role="status"')
    const failed = renderToStaticMarkup(<AddOrFind initial={addOutcome({ ok: false, reason: 'other_owner', offers: [{ kind: 'employer', name: 'Retell AI', employerId: 'e1' }] }, {})} />)
    expect(text(failed)).toContain('This board belongs to a different employer.')
    expect(text(failed)).toContain('Follow Retell AI')
    const added = renderToStaticMarkup(<AddOrFind initial={addOutcome({ ok: true, companyId: 'c', already: false, employer })} />)
    expect(text(added)).toContain('Following Retell AI. Cello is reading its site now.')
    expect(added).toContain('href="/companies/e1"')
  })
})

describe('what the page never says', () => {
  const ROOT = process.cwd()
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = path.join(dir, e)
      if (statSync(full).isDirectory()) return walk(full)
      return /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [full] : []
    })
  const files = [...walk(path.join(ROOT, 'components/companies')), ...walk(path.join(ROOT, 'app/(app)/companies')), path.join(ROOT, 'app/fixtures/companies/page.tsx')]
  const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/')
  const src = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')

  it('reads real files', () => {
    expect(files.some((f) => rel(f) === 'components/companies/logic.ts')).toBe(true)
    expect(files.some((f) => rel(f) === 'app/(app)/companies/read.ts')).toBe(true)
  })

  it('has no claim that an employer does not sponsor, no dream, and no word for a sent receipt', () => {
    for (const f of files) {
      expect(src(f), rel(f)).not.toMatch(/does not sponsor|doesn't sponsor|will not sponsor/i)
      expect(src(f), rel(f)).not.toMatch(/\bdream\b/i)
      expect(src(f), rel(f)).not.toMatch(/receipt/i)
    }
  })

  it('reaches no model itself: no step, no model call, no model list on a row (Check my chance goes through the fit step)', () => {
    for (const f of files) expect(src(f), rel(f)).not.toMatch(/lib\/steps|lib\/models|lib\/harness\/llm['"/]|callLlm/)
  })

  it('writes a follow only through the one follow function', () => {
    const writers = files.filter((f) => /from\(\s*['"`]companies['"`]\s*\)\s*\.(update|insert|upsert)\(|\bwatching\s*:\s*(true|false|change)/.test(src(f))).map(rel)
    expect(writers).toEqual(['app/(app)/companies/follow.stub.ts'])
  })
})
