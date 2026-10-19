// The code check on a drafted answer: a fact the person never gave is refused, a company quote not in the research
// is refused, and a draft inside the person's own words passes.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: vi.fn() }))
vi.mock('@/lib/models/choice', () => ({ roleKeys: vi.fn() }))
vi.mock('@/lib/models/ask', () => ({ stepRunner: vi.fn() }))
vi.mock('@/lib/steps', () => ({ answerDraftStep: {} }))
vi.mock('@/lib/workflows/gather/apply', () => ({ personEvidence: vi.fn(() => ''), renderContext: vi.fn(() => ''), sharesWords: vi.fn(() => false), sourcesUsed: vi.fn(() => []) }))

import { stepRunner } from '@/lib/models/ask'
import { FreeCapError } from '@/lib/models/caps'
import { checkDraft, draftAnswer } from './draft'

const own = 'Riley Marsh\nBackend engineer at Northwind, 2019 to 2024.\nLed a team of 6 engineers.\nWhy this company?\nI ran Kubernetes clusters for a payments team at Northwind for three years.'
const company = 'Acme was founded in 2010 and sells Observability tools. "Monitoring for everyone" is its line.'
const question = 'Why do you want to work at Acme?'

describe('checkDraft', () => {
  it('passes a draft inside the person\'s own words that names the company as written', () => {
    expect(checkDraft('I ran Kubernetes clusters for a payments team at Northwind for three years, and Acme sells Observability tools I would like to build. Leading a team of 6 engineers taught me to keep systems simple.', own, company, question)).toBeNull()
  })

  it('refuses a fact the person never gave', () => {
    expect(checkDraft('I led a team of 40 engineers at Google for twelve years.', own, company, question)).toMatch(/40|Google|twelve/)
    expect(checkDraft('I started at Northwind on 2016-03-01.', own, company, question)).toMatch(/the date mar 1/)
  })

  it('never uses the form question or employer research as evidence about the person', () => {
    expect(checkDraft('I worked at Anthropic before this.', own, 'Anthropic has 1,200 employees and raised $4 billion in 2024 from Amazon.', 'Why Anthropic?')).toMatch(/Anthropic/)
    expect(checkDraft('I managed a team of 1,200 employees and raised $4 billion for Amazon.', own, 'Anthropic has 1,200 employees and raised $4 billion in 2024 from Amazon.', 'Why Anthropic?')).toMatch(/1,200|4|Amazon/)
  })

  it('fails closed on a generic fabricated personal claim', () => {
    expect(checkDraft('I am an astronaut who performs surgery on dolphins.', own, company, question)).toMatch(/astronaut|surgery|dolphins/)
    expect(checkDraft('I am an astronaut.', own, company, question)).toMatch(/astronaut/)
  })

  it('passes a personal claim supported by the person\'s own source', () => {
    expect(checkDraft('I ran Kubernetes clusters for a payments team at Northwind for three years.', own, company, question)).toBeNull()
  })

  it('refuses quoted company words the research does not hold', () => {
    expect(checkDraft('Your line "observability for the brave" speaks to me.', own, company, question)).toMatch(/the quotation "observability for the brave"/)
    expect(checkDraft('Your line "Monitoring for everyone" speaks to me.', own, company, question)).toBeNull()
  })
})

describe('draftAnswer failure copy', () => {
  const context = { requirements: [], fit: [], company: [], history: [], answers: [], profile: [] }
  const input = { question: 'Why do you want to work here?', answerId: 'answer-1', context, resume: { id: 'resume-1', text: own } }
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { id: 'answer-1', category: 'other', answer: null, origin: 'user' }, error: null }) }),
        }),
      }),
    }),
  } as never

  it('does not expose provider or model identifiers when every free model fails', async () => {
    vi.mocked(stepRunner).mockReturnValue(vi.fn(async () => {
      throw new Error('No free model could do this just now. nvidia/nemotron-3-super-120b-a12b:free returned nothing | google/gemma-4-31b-it:free failed')
    }) as never)

    const out = await draftAnswer(admin, 'user-1', input)

    expect(out).toEqual({ ok: false, reason: 'The draft could not be written.' })
    expect(JSON.stringify(out)).not.toMatch(/nemotron|gemma|:free/)
  })

  it('keeps a known free-model cap reason actionable', async () => {
    vi.mocked(stepRunner).mockReturnValue(vi.fn(async () => {
      throw new FreeCapError('drafts')
    }) as never)

    await expect(draftAnswer(admin, 'user-1', input)).resolves.toEqual({
      ok: false,
      reason: 'Free models allow 5 drafts a day. Add credit in Settings, under Models, or choose another model.',
    })
  })
})
