import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

import { WelcomeFlow } from '../welcome-flow'
import { Progress } from './progress'
import { DemoScreen } from './demo-tour'
import {
  SCREENS,
  THIN_LINE,
  dismissTour,
  fitLine,
  nameFromResume,
  nextScreen,
  readLine,
  readResume,
  tourDismissed,
  tourStops,
  typedTitle,
} from './logic'
import { toTargeting, setFacts, EMPTY_WELCOME_TARGETS } from '@/lib/welcome/commands'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('the resume line', () => {
  it('counts the words read and names the first heading', () => {
    const body = '# Senior Software Engineer\n' + 'word '.repeat(311)
    const r = readResume(body)
    expect(r.words).toBe(314)
    expect(readLine(r)).toBe('Read 314 words. First heading: Senior Software Engineer.')
    expect(r.thin).toBe(false)
  })

  it('says it is thin under 150 words', () => {
    expect(readResume('a b c').thin).toBe(true)
    expect(THIN_LINE).toBe('That is thin. Chances are checked against these lines.')
    expect(readLine(readResume('one'))).toBe('Read 1 word.')
  })

  it('takes the name from a short first line only', () => {
    expect(nameFromResume('# Sam Rivera\nsam@example.com')).toBe('Sam Rivera')
    expect(nameFromResume('Curriculum vitae of an engineer with many years of work in data')).toBe('')
    expect(nameFromResume('sam@example.com')).toBe('')
  })
})

describe('the live line and the typed title', () => {
  it('is a count, or nothing when it cannot be counted', () => {
    expect(fitLine(41)).toBe('41 open roles fit this right now.')
    expect(fitLine(1)).toBe('1 open role fits this right now.')
    expect(fitLine(0)).toBe('No open roles fit this yet.')
    expect(fitLine(null)).toBeNull()
  })

  it('names the type of a typed title in code', () => {
    const t = typedTitle('AI Engineer')
    expect(t?.line).toMatch(/^AI Engineer is a .+ role\.$/)
    expect(typedTitle('Chief Happiness Officer')).toBeNull()
  })

  it('turns picks into the targeting main stores', () => {
    const t = toTargeting({ ...EMPTY_WELCOME_TARGETS, roleTypeIds: ['ai-engineer', 'data-engineer'], levelIds: ['senior'], remoteOnly: true, excludedCompanies: [' Acme '] })
    expect(t.functions.sort()).toEqual(['data', 'engineering'])
    expect(t.seniority).toEqual(['senior'])
    expect(t.remoteOnly).toBe(true)
    expect(t.excludedCompanies).toEqual(['acme'])
  })
})

describe('progress', () => {
  it('never says step', () => {
    for (const s of SCREENS) expect(text(renderToStaticMarkup(<Progress screen={s} />))).not.toMatch(/step/i)
  })
  it('moves forward and stops at the last screen', () => {
    expect(nextScreen('resume')).toBe('want')
    expect(nextScreen('roles')).toBe('roles')
  })
})

describe('the guided demo', () => {
  it('never asks a demo for a key', () => {
    const t = text(renderToStaticMarkup(<WelcomeFlow demo initialName="" hasResume={false} start="resume" />))
    expect(t).toContain('72 hours, $1.00 of AI budget, made-up companies')
    expect(t).not.toMatch(/Use a key|OpenRouter|Connect Gmail|API key/i)
  })

  it('shows only stops whose page has shipped', () => {
    for (const s of tourStops()) expect(s.route.shipped).toBe(true)
    expect(text(renderToStaticMarkup(<DemoScreen onFinish={() => undefined} finishing={false} />))).not.toContain('Skip the tour')
  })

  it('stays dismissed once dismissed, and a store that cannot be read counts as dismissed', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(tourDismissed(store)).toBe(false)
    dismissTour(store)
    expect(data.get('cello.tour.dismissed')).toBe('1')
    expect(tourDismissed(store)).toBe(true)
    expect(tourDismissed({ getItem: () => { throw new Error('blocked') }, setItem: () => undefined })).toBe(true)
    expect(tourDismissed(null)).toBe(true)
  })
})

describe('a real account', () => {
  it('opens on the resume screen with a progress bar and no key-first flow', () => {
    const html = renderToStaticMarkup(<WelcomeFlow demo={false} initialName="Sam" hasResume={false} start="resume" />)
    expect(html).toContain('role="progressbar"')
    expect(text(html)).toContain('Start with your resume')
    expect(text(html)).not.toMatch(/API key|OpenRouter/i)
  })
})

describe('the facts', () => {
  const stored = { blockedCountries: ['RU'], onlyCountries: [], onsiteCities: ['berlin'], needsSponsorship: false, salaryFloorUsd: null, remoteOnly: false, excludedCompanies: [], refusedSeniority: ['intern'], excludedTitleWords: [] }

  function fakeFetch() {
    const puts: unknown[] = []
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return { ok: true, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({ constraints: stored }) }
    })
    vi.stubGlobal('fetch', fn)
    return puts
  }

  it('keeps the fields it did not edit and sends the countries and sponsorship as two facts', async () => {
    const puts = fakeFetch()
    const ok = await setFacts({ ...EMPTY_WELCOME_TARGETS, countries: ['us', 'ca'], needsSponsorship: true, salaryFloorUsd: 150000 })
    expect(ok).toBe(true)
    expect(puts).toEqual([{ ...stored, onlyCountries: ['US', 'CA'], needsSponsorship: true, salaryFloorUsd: 150000 }])
    vi.unstubAllGlobals()
  })

  it('writes nothing when no fact was asked, and does not overwrite an unanswered sponsorship', async () => {
    const puts = fakeFetch()
    expect(await setFacts(EMPTY_WELCOME_TARGETS)).toBe(true)
    expect(puts).toEqual([])
    await setFacts({ ...EMPTY_WELCOME_TARGETS, salaryFloorUsd: 90000 })
    expect(puts).toEqual([{ ...stored, salaryFloorUsd: 90000 }])
    vi.unstubAllGlobals()
  })
})
