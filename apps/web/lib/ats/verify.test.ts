// Board ownership: a guessed board is the company's only with evidence, and only while alive.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The careers page is a plain https GET to whatever host the person typed; the
// DNS check is not what these tests are about.
vi.mock('../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

import { detectAts } from './detect'
import { isRecentBoard, mentionsDomain, normalizeEmployerName, sameEmployerName, tokenMatchesDomainLabel, verifyBoard } from './verify'
import { healStoredBoard } from './heal'
import { providers } from './index'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const PERSONIO_AMAZON = readFileSync(path.join(__dirname, '__fixtures__/personio-amazon.xml'), 'utf8')
const MONTH_AGO = new Date(Date.now() - 30 * 86_400_000).toISOString()
const MONTHS_13_AGO = new Date(Date.now() - 395 * 86_400_000).toISOString()

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
const miss = () => new Response('not found', { status: 404, statusText: 'Not Found' })

/** Route every GET by URL; anything unrouted is a 404. Returns the URLs asked for. */
function route(handler: (url: string) => Response | undefined) {
  const urls: string[] = []
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    return handler(url) ?? miss()
  }) as unknown as typeof fetch
  return urls
}

const ghBoard = (jobs: Array<{ url: string; published: string; content?: string }>) => ({
  jobs: jobs.map((j, i) => ({
    absolute_url: j.url,
    title: `Engineer ${i}`,
    first_published: j.published,
    location: { name: 'Remote' },
    ...(j.content ? { content: j.content } : {}),
  })),
})

const ashbyBoard = (token: string) => ({
  jobs: [{ title: 'Engineer', jobUrl: `https://jobs.ashbyhq.com/${token}/1`, publishedAt: MONTH_AGO }],
})
const ashbyPage = (name: string, site: string) => html(`<script>{"name":"${name}","publicWebsite":"${site}"}</script>`)

describe('the Amazon / Personio false match', () => {
  const amazon = { name: 'Amazon', domain: 'amazon.jobs', careerUrl: 'https://www.amazon.jobs/en/search' }

  it('serves London marketing posts from 2017 on the namesake board: the recorded fixture', () => {
    expect(PERSONIO_AMAZON).toContain('2017-05-23')
  })

  it('never takes a namesake board for Amazon, and never slug-probes a known employer', async () => {
    const urls = route((u) => (u.includes('personio.de') ? new Response(PERSONIO_AMAZON, { status: 200 }) : undefined))
    await expect(detectAts(amazon)).resolves.toBeNull()
    expect(urls.some((u) => u.includes('personio'))).toBe(false)
    expect(urls.some((u) => u.includes('greenhouse.io') || u.includes('ashbyhq') || u.includes('lever.co'))).toBe(false)
  })

  it('rejects the same feed for an unknown company: it is dead (newest post 2018)', async () => {
    route((u) => (u.includes('personio.de') ? new Response(PERSONIO_AMAZON, { status: 200 }) : undefined))
    await expect(detectAts({ name: 'Amazonshop', domain: 'amazonshop.example', careerUrl: null })).resolves.toBeNull()
  })

  it('rejects it even when re-dated to last month: Personio names no employer, so only a page link can vouch', async () => {
    const fresh = PERSONIO_AMAZON.replace(/<createdAt>[^<]*<\/createdAt>/g, `<createdAt>${MONTH_AGO}</createdAt>`)
    route((u) => (u.includes('personio.de') ? new Response(fresh, { status: 200 }) : undefined))
    await expect(detectAts({ name: 'Amazonshop', domain: 'amazonshop.example', careerUrl: null })).resolves.toBeNull()
  })

  it('verifyBoard on the real personio adapter output says nothing ties it to Amazon', async () => {
    route((u) => (u.includes('personio.de') ? new Response(PERSONIO_AMAZON, { status: 200 }) : undefined))
    const jobs = await providers.personio.fetch('amazon')
    expect(jobs.length).toBeGreaterThan(0)
    await expect(
      verifyBoard({ provider: 'personio', token: 'amazon', jobs, company: { name: 'Amazon', domain: 'amazon.jobs' } })
    ).resolves.toBeNull()
  })
})

describe('a dead board', () => {
  it('is never accepted, even when its postings link to the company domain', async () => {
    route((u) =>
      u.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')
        ? json(ghBoard([{ url: 'https://acme.com/jobs/1', published: MONTHS_13_AGO }]))
        : undefined
    )
    await expect(detectAts({ name: 'Acme', domain: 'acme.com', careerUrl: null })).resolves.toBeNull()
  })

  it('is accepted with the same evidence once it has a recent posting', async () => {
    route((u) =>
      u.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')
        ? json(ghBoard([{ url: 'https://acme.com/jobs/1', published: MONTH_AGO }]))
        : undefined
    )
    await expect(detectAts({ name: 'Acme', domain: 'acme.com', careerUrl: null })).resolves.toMatchObject({
      provider: 'greenhouse',
      token: 'acme',
      source: 'probe',
      verifiedBy: 'board_links_home',
    })
  })

  it('isRecentBoard: 12 months, and undated is dead', () => {
    expect(isRecentBoard([{ title: 't', url: 'u', externalId: 'u', postedAt: MONTH_AGO }])).toBe(true)
    expect(isRecentBoard([{ title: 't', url: 'u', externalId: 'u', postedAt: MONTHS_13_AGO }])).toBe(false)
    expect(isRecentBoard([{ title: 't', url: 'u', externalId: 'u' }])).toBe(false)
    expect(isRecentBoard([])).toBe(false)
  })
})

describe('a board verified through the careers page', () => {
  const acme = { name: 'Acme Robotics', domain: 'acme.io', careerUrl: 'https://acme.io/careers' }
  // Postings live on the provider's host and the provider names someone else: only the page link ties it.
  const board = () => json(ghBoard([{ url: 'https://boards.greenhouse.io/acmehq/jobs/1', published: MONTH_AGO }]))
  const serve = (careersHtml: string) =>
    route((u) => {
      if (u.startsWith('https://acme.io/careers')) return html(careersHtml)
      if (u.includes('/v1/boards/acmehq/jobs')) return board()
      if (u.endsWith('/v1/boards/acmehq')) return json({ name: 'Something Else Ltd' })
      return undefined
    })

  it('accepts the exact board the careers page links to', async () => {
    serve('<a href="https://job-boards.greenhouse.io/acmehq">Open roles</a>')
    await expect(detectAts(acme)).resolves.toMatchObject({
      provider: 'greenhouse',
      token: 'acmehq',
      verifiedBy: 'careers_page_link',
    })
  })

  it('finds a board embedded in a script bundle with escaped slashes', async () => {
    serve('<script>var u="https:\\/\\/job-boards.greenhouse.io\\/acmehq";</script>')
    await expect(detectAts(acme)).resolves.toMatchObject({ provider: 'greenhouse', token: 'acmehq' })
  })

  it('gets nothing from a page that does not link to it (a guess has no evidence)', async () => {
    serve('<p>Join us</p>')
    await expect(detectAts({ ...acme, name: 'Acmehq' })).resolves.toBeNull()
  })

  it('treats a page full of boards as a directory, not as evidence', async () => {
    const many = ['a', 'b', 'c', 'acmehq'].map((t) => `<a href="https://boards.greenhouse.io/${t}">x</a>`).join('')
    serve(many)
    await expect(detectAts(acme)).resolves.toBeNull()
  })

  it('reads a heavy page as far as the cap instead of refusing it', async () => {
    const heavy = `<a href="https://jobs.ashbyhq.com/acmehq">Roles</a>${'<!-- padding -->'.repeat(200_000)}`
    route((u) => {
      if (u.startsWith('https://acme.io/careers')) return html(heavy)
      if (u.includes('/posting-api/job-board/acmehq')) {
        return json({ jobs: [{ title: 'Engineer', jobUrl: 'https://jobs.ashbyhq.com/acmehq/1', publishedAt: MONTH_AGO }] })
      }
      return undefined
    })
    await expect(detectAts(acme)).resolves.toMatchObject({ provider: 'ashby', verifiedBy: 'careers_page_link' })
  })

  it('does not follow a redirect off the company site', async () => {
    const urls = route((u) => {
      if (u.startsWith('https://acme.io/careers')) {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/boards' } })
      }
      return undefined
    })
    await expect(detectAts(acme)).resolves.toBeNull()
    expect(urls.some((u) => u.startsWith('https://evil.example'))).toBe(false)
  })
})

describe('provider name plus domain label', () => {
  it('accepts a board whose provider names the same employer and whose token is the domain label', async () => {
    route((u) => {
      if (u.includes('/v1/boards/quillbot/jobs')) {
        return json(
          ghBoard([{ url: 'https://job-boards.greenhouse.io/quillbot/jobs/1', published: MONTH_AGO, content: 'Apply via quillbot.example/careers' }])
        )
      }
      if (u.endsWith('/v1/boards/quillbot')) return json({ name: 'Quillbot, Inc.' })
      return undefined
    })
    await expect(detectAts({ name: 'Quillbot', domain: 'quillbot.example', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'provider_name',
    })
  })

  it('counts a link to the company site inside the posting body, which the plain text drops', async () => {
    route((u) => {
      if (u.includes('/v1/boards/quillbot/jobs')) {
        return json(
          ghBoard([
            {
              url: 'https://job-boards.greenhouse.io/quillbot/jobs/1',
              published: MONTH_AGO,
              content: '&lt;p&gt;See our &lt;a href=&quot;https://www.quillbot.example/privacy&quot;&gt;privacy notice&lt;/a&gt;&lt;/p&gt;',
            },
          ])
        )
      }
      if (u.endsWith('/v1/boards/quillbot')) return json({ name: 'Quillbot' })
      return undefined
    })
    await expect(detectAts({ name: 'Quillbot', domain: 'quillbot.example', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'provider_name',
    })
  })

  it('a name equal to the domain label is not enough on its own (Gong on Recruitee is a Polish bus company)', async () => {
    route((u) => {
      if (u.includes('/v1/boards/quillbot/jobs')) {
        return json(ghBoard([{ url: 'https://job-boards.greenhouse.io/quillbot/jobs/1', published: MONTH_AGO, content: 'We build things.' }]))
      }
      if (u.endsWith('/v1/boards/quillbot')) return json({ name: 'Quillbot' })
      return undefined
    })
    await expect(detectAts({ name: 'Quillbot', domain: 'quillbot.example', careerUrl: null })).resolves.toBeNull()
  })

  it("accepts a Greenhouse board whose logo links to the company's site (Calendly, Dialpad)", async () => {
    route((u) => {
      if (u.includes('/v1/boards/quillbot/jobs')) {
        return json(ghBoard([{ url: 'https://job-boards.greenhouse.io/quillbot/jobs/1', published: MONTH_AGO }]))
      }
      if (u.endsWith('/v1/boards/quillbot')) return json({ name: 'Quillbot' })
      if (u === 'https://job-boards.greenhouse.io/quillbot') {
        return html('<script>{"boardConfiguration":{"job_board_id":1,"logo":{"href":"https://www.quillbot.example/careers","url":"x"}}}</script>')
      }
      return undefined
    })
    await expect(detectAts({ name: 'Quillbot', domain: 'quillbot.example', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'board_links_home',
    })
  })

  it("rejects a Greenhouse board whose logo links to another employer's site", async () => {
    route((u) => {
      if (u.includes('/v1/boards/quillbot/jobs')) {
        return json(ghBoard([{ url: 'https://job-boards.greenhouse.io/quillbot/jobs/1', published: MONTH_AGO, content: 'See quillbot.example' }]))
      }
      if (u.endsWith('/v1/boards/quillbot')) return json({ name: 'Quillbot' })
      if (u === 'https://job-boards.greenhouse.io/quillbot') {
        return html('<script>{"boardConfiguration":{"logo":{"href":"https://quillbot-buses.example/","url":"x"}}}</script>')
      }
      return undefined
    })
    await expect(detectAts({ name: 'Quillbot', domain: 'quillbot.example', careerUrl: null })).resolves.toBeNull()
  })

  it('accepts the same name, the domain label and one posting that names the company site', async () => {
    route((u) => {
      if (u.includes('/v1/boards/quillbot/jobs')) {
        return json(ghBoard([{ url: 'https://job-boards.greenhouse.io/quillbot/jobs/1', published: MONTH_AGO, content: 'Read more at quillbot.example/about.' }]))
      }
      if (u.endsWith('/v1/boards/quillbot')) return json({ name: 'Quillbot' })
      return undefined
    })
    await expect(detectAts({ name: 'Quillbot', domain: 'quillbot.example', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'provider_name',
    })
  })

  it('a namesake is not the company: the board links to mercury.com, the company is mercury.co', async () => {
    route((u) => {
      if (u.includes('/v1/boards/mercury/jobs')) {
        return json(
          ghBoard([
            { url: 'https://job-boards.greenhouse.io/mercury/jobs/1', published: MONTH_AGO, content: 'Open an account at mercury.com today.' },
            { url: 'https://job-boards.greenhouse.io/mercury/jobs/2', published: MONTH_AGO, content: 'Try the demo at https://demo.mercury.com and mercury.com/pricing.' },
          ])
        )
      }
      if (u.endsWith('/v1/boards/mercury')) return json({ name: 'Mercury' })
      return undefined
    })
    // The fintech's own domain: its postings name it, so the board is its.
    await expect(detectAts({ name: 'Mercury', domain: 'mercury.com', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'board_links_home',
    })
    // A different Mercury on mercury.co: the name and the label match, but the postings name mercury.com.
    await expect(detectAts({ name: 'Mercury', domain: 'mercury.co', careerUrl: null })).resolves.toBeNull()
  })

  it('a bare substring is not a mention: x.co is not in x.com, and a.ai is not in a.air', () => {
    expect(mentionsDomain('Visit mercury.com now', 'mercury.co')).toBe(false)
    expect(mentionsDomain('see mercury.co.uk', 'mercury.co')).toBe(false)
    expect(mentionsDomain('notmercury.co', 'mercury.co')).toBe(false)
    expect(mentionsDomain('x.ai/careers and a.air', 'x.a')).toBe(false)
    expect(mentionsDomain('Visit mercury.co.', 'mercury.co')).toBe(true)
    expect(mentionsDomain('https://www.mercury.co/jobs', 'mercury.co')).toBe(true)
    expect(mentionsDomain('mail careers@mercury.co', 'mercury.co')).toBe(true)
  })

  it('two postings that name the company site tie a board to it even when the provider names someone else (Pure Storage / Everpure)', async () => {
    route((u) => {
      if (u.includes('/v1/boards/purestorage/jobs')) {
        return json(
          ghBoard([
            { url: 'https://job-boards.greenhouse.io/purestorage/jobs/1', published: MONTH_AGO, content: 'Learn more at purestorage.com.' },
            { url: 'https://job-boards.greenhouse.io/purestorage/jobs/2', published: MONTH_AGO, content: '&lt;a href=&quot;https://www.purestorage.com/company&quot;&gt;About&lt;/a&gt;' },
          ])
        )
      }
      if (u.endsWith('/v1/boards/purestorage')) return json({ name: 'Everpure' })
      return undefined
    })
    await expect(detectAts({ name: 'Pure Storage', domain: 'purestorage.com', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'board_links_home',
    })
  })

  it('one passing mention is not enough', async () => {
    route((u) => {
      if (u.includes('/v1/boards/sprout/jobs')) {
        return json(ghBoard([{ url: 'https://job-boards.greenhouse.io/sprout/jobs/1', published: MONTH_AGO, content: 'Competes with sprout.example.' }]))
      }
      if (u.endsWith('/v1/boards/sprout')) return json({ name: 'Other Sprout Holdings' })
      return undefined
    })
    await expect(detectAts({ name: 'Sprout', domain: 'sprout.example', careerUrl: null })).resolves.toBeNull()
  })

  it('reads "Honeycomb.io" as Honeycomb', () => {
    expect(sameEmployerName('Honeycomb.io', 'Honeycomb')).toBe(true)
    expect(sameEmployerName('Honeycomb.io', 'Honeycomb Insurance')).toBe(false)
  })

  it.each([
    ['Atlas', 'atlas.co', 'atlas', 'https://atlascard.com/'],
    ['Prism', 'prism.so', 'prism', 'https://prism-global.com/'],
  ])("rejects %s: its board declares another employer's site (%s)", async (name, domain, token, site) => {
    route((u) => {
      if (u.includes(`/posting-api/job-board/${token}`)) return json(ashbyBoard(token))
      if (u === `https://jobs.ashbyhq.com/${token}`) return ashbyPage(name, site)
      return undefined
    })
    await expect(detectAts({ name, domain, careerUrl: null })).resolves.toBeNull()
  })

  it('accepts an Ashby board whose declared site is the company domain', async () => {
    route((u) => {
      if (u.includes('/posting-api/job-board/kiln')) return json(ashbyBoard('kiln'))
      if (u === 'https://jobs.ashbyhq.com/kiln') return ashbyPage('Kiln', 'https://www.kiln.so/')
      return undefined
    })
    await expect(detectAts({ name: 'Kiln', domain: 'kiln.so', careerUrl: null })).resolves.toMatchObject({
      verifiedBy: 'board_links_home',
    })
  })

  it('reads "Rover.com" as Rover', () => {
    expect(sameEmployerName('Rover.com', 'Rover')).toBe(true)
  })

  it('normalises legal suffixes but not a different employer sharing the first word', () => {
    expect(normalizeEmployerName('Gusto, Inc.')).toBe('gusto')
    expect(sameEmployerName('Gusto, Inc.', 'Gusto')).toBe(true)
    expect(sameEmployerName('Wise Worksite Field Sales', 'Wise')).toBe(false)
    expect(sameEmployerName(null, 'Wise')).toBe(false)
  })

  it('a token must be the domain label: scaleai is not scale', () => {
    expect(tokenMatchesDomainLabel('scaleai', 'scale.com')).toBe(false)
    expect(tokenMatchesDomainLabel('scale', 'www.scale.com')).toBe(true)
  })
})

describe('known employers', () => {
  it('use their curated board with no slug probing', async () => {
    const urls = route((u) =>
      u.includes('/v1/boards/stripe/jobs')
        ? json(ghBoard([{ url: 'https://stripe.com/jobs/search?gh_jid=1', published: MONTH_AGO }]))
        : undefined
    )
    const found = await detectAts({ name: 'Stripe', domain: 'stripe.com', careerUrl: null })
    expect(found).toMatchObject({ provider: 'greenhouse', token: 'stripe', source: 'known', verifiedBy: 'known_board' })
    expect(urls.every((u) => u.includes('greenhouse.io/v1/boards/stripe'))).toBe(true)
  })

  it.each([
    ['SpaceX', 'spacex.com', 'greenhouse', 'spacex'],
    ['Intercom', 'intercom.com', 'greenhouse', 'intercom'],
    ['Typeform', 'typeform.com', 'greenhouse', 'typeform'],
    ['Smartsheet', 'smartsheet.com', 'greenhouse', 'smartsheet'],
  ])('%s has a curated board even though its page does not link to it', async (name, domain, provider, token) => {
    route((u) =>
      u.includes(`/v1/boards/${token}/jobs`)
        ? json(ghBoard([{ url: `https://job-boards.greenhouse.io/${token}/jobs/1`, published: MONTH_AGO }]))
        : undefined
    )
    await expect(detectAts({ name, domain, careerUrl: null })).resolves.toMatchObject({ provider, token, verifiedBy: 'known_board' })
  })

  it('a curated board that has gone dead is not used', async () => {
    route((u) =>
      u.includes('/v1/boards/stripe/jobs')
        ? json(ghBoard([{ url: 'https://stripe.com/jobs/search?gh_jid=1', published: MONTHS_13_AGO }]))
        : undefined
    )
    await expect(detectAts({ name: 'Stripe', domain: 'stripe.com', careerUrl: null })).resolves.toBeNull()
  })

  it("Google's sample recruitee board is not Google's, even though its name and token match", async () => {
    const jobs = [{ title: 'Senior Marketer (Sample)', url: 'https://google.recruitee.com/o/1', externalId: 'u', postedAt: MONTH_AGO }]
    route((u) => (u.includes('google.recruitee.com/api/offers') ? json({ offers: [{ company_name: 'Google', careers_url: 'https://google.recruitee.com' }] }) : undefined))
    await expect(
      verifyBoard({ provider: 'recruitee', token: 'google', jobs, company: { name: 'Google', domain: 'google.com' }, knownEmployer: true })
    ).resolves.toBeNull()
    // A known employer is never matched by name: only its own page's link counts.
  })
})

describe('healStoredBoard', () => {
  const jobs = [{ title: 'Marketing', url: 'https://amazon.jobs.personio.de/job/1', externalId: 'u', postedAt: '2018-10-22T00:00:00Z' }]
  const co = { id: 'c1', name: 'Amazon', domain: 'amazon.jobs', career_url: 'https://www.amazon.jobs/en/search' }

  it('leaves a trusted board alone', async () => {
    const store = { clearBoardJobs: vi.fn() }
    const out = await healStoredBoard(store, co, { provider: 'personio', token: 'amazon', source: 'url' }, jobs)
    expect(out).toEqual({ kept: true })
    expect(store.clearBoardJobs).not.toHaveBeenCalled()
  })

  it('clears a guessed board that fails verification', async () => {
    route(() => undefined)
    const store = { clearBoardJobs: vi.fn(async () => ({ deleted: 2, closed: 1 })) }
    const out = await healStoredBoard(store, co, { provider: 'personio', token: 'amazon', source: 'probe' }, jobs)
    expect(out).toEqual({ kept: false, cleared: { deleted: 2, closed: 1 } })
    expect(store.clearBoardJobs).toHaveBeenCalledWith('c1', 'personio')
  })

  it("does not clear a known employer's own curated board", async () => {
    const store = { clearBoardJobs: vi.fn() }
    const stripe = { id: 's', name: 'Stripe', domain: 'stripe.com', career_url: null }
    const out = await healStoredBoard(store, stripe, { provider: 'greenhouse', token: 'stripe', source: 'probe' }, jobs)
    expect(out).toEqual({ kept: true, verifiedBy: 'known_board' })
    expect(store.clearBoardJobs).not.toHaveBeenCalled()
  })

  it('keeps a board when the provider could not be asked, and clears it when the provider says not found', async () => {
    const ghJobs = [{ title: 'Eng', url: 'https://job-boards.greenhouse.io/acme/jobs/1', externalId: 'u', postedAt: MONTH_AGO }]
    const acme = { id: 'a', name: 'Acme', domain: 'acme.io', career_url: null }
    const cached = { provider: 'greenhouse' as const, token: 'acme', source: 'probe' }

    route(() => new Response('refused', { status: 403, statusText: 'Forbidden' }))
    const kept = { clearBoardJobs: vi.fn() }
    await expect(healStoredBoard(kept, acme, cached, ghJobs)).resolves.toEqual({ kept: true })
    expect(kept.clearBoardJobs).not.toHaveBeenCalled()

    route(() => undefined) // 404 everywhere: the provider answered, and it says nothing ties the board to Acme
    const cleared = { clearBoardJobs: vi.fn(async () => ({ deleted: 1, closed: 0 })) }
    await expect(healStoredBoard(cleared, acme, cached, ghJobs)).resolves.toMatchObject({ kept: false })
    expect(cleared.clearBoardJobs).toHaveBeenCalledWith('a', 'greenhouse')
  })

  it('keeps a board when only its logo page could not be read (a 429 is not "no logo")', async () => {
    const ghJobs = [{ title: 'Eng', url: 'https://job-boards.greenhouse.io/acme/jobs/1', externalId: 'u', postedAt: MONTH_AGO }]
    const acme = { id: 'a', name: 'Acme', domain: 'acme.io', career_url: null }
    route((u) =>
      u.endsWith('/v1/boards/acme')
        ? json({ name: 'Acme' })
        : u === 'https://job-boards.greenhouse.io/acme'
          ? new Response('slow down', { status: 503, statusText: 'Service Unavailable' })
          : undefined
    )
    const store = { clearBoardJobs: vi.fn() }
    await expect(healStoredBoard(store, acme, { provider: 'greenhouse', token: 'acme', source: 'probe' }, ghJobs)).resolves.toEqual({ kept: true })
    expect(store.clearBoardJobs).not.toHaveBeenCalled()
  })

  it('lets a store error through, so the caller changes nothing', async () => {
    route(() => undefined)
    const store = { clearBoardJobs: vi.fn(async () => { throw new Error('rpc missing') }) }
    await expect(healStoredBoard(store, co, { provider: 'personio', token: 'amazon', source: 'probe' }, jobs)).rejects.toThrow('rpc missing')
  })
})
