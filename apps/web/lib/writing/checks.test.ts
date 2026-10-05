import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDraft, countAsks, countWords, type DraftCheckInput } from './checks'

const GOOD_BODY = [
  'Hi Jane,',
  '',
  'I built the idempotent ledger at Halcyon Pay that cut reconciliation breaks by 92%, and Ramp is hiring a Senior Backend Engineer for payments.',
  '',
  'Would you be open to a 15 minute chat about the team?',
  '',
  'Thanks,',
  'Marcus Delgado',
].join('\n')

const base: DraftCheckInput = {
  kind: 'outreach',
  subject: 'Senior Backend Engineer at Ramp',
  body: GOOD_BODY,
  senderName: 'Marcus Delgado',
  contactName: 'Jane Park',
  companyName: 'Ramp',
  hasHistory: false,
}

function failing(input: DraftCheckInput): string[] {
  return checkDraft(input).checks.filter((c) => !c.ok).map((c) => c.id)
}

describe('checkDraft', () => {
  it('passes a plain draft', () => {
    const res = checkDraft(base)
    expect(res.checks.filter((c) => !c.ok)).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('fails two asks', () => {
    const body = GOOD_BODY.replace('Thanks,', 'Happy to send my resume as well.\n\nThanks,')
    expect(failing({ ...base, body })).toEqual(['one_ask'])
    expect(checkDraft({ ...base, body }).checks.find((c) => c.id === 'one_ask')?.message).toBe('2 asks. Keep one so the reply is easy.')
  })

  it('fails a body with no ask', () => {
    expect(failing({ ...base, body: GOOD_BODY.replace(/Would you be open[^\n]*\n\n/, '') })).toEqual(['one_ask'])
  })

  it('fails 121 words and passes 120', () => {
    const pad = (n: number) => ['Hi Jane,', '', `${'word '.repeat(n)}Ramp?`, '', 'Thanks,', 'Marcus Delgado'].join('\n')
    const at120 = pad(120 - 6)
    expect(countWords(at120)).toBe(120)
    expect(failing({ ...base, body: at120 })).toEqual([])
    const at121 = pad(121 - 6)
    expect(countWords(at121)).toBe(121)
    expect(checkDraft({ ...base, body: at121 }).checks.find((c) => c.id === 'word_count')?.message).toBe('121 words. Keep it under 120.')
  })

  it('fails an em dash and an en dash in the subject or body', () => {
    expect(failing({ ...base, subject: 'Ramp — quick note' })).toContain('no_em_dash')
    expect(failing({ ...base, body: GOOD_BODY.replace('hiring', 'hiring –') })).toContain('no_em_dash')
  })

  it('fails a sign-off that is not the sender name', () => {
    const res = checkDraft({ ...base, body: GOOD_BODY.replace('Marcus Delgado', 'mdelgado') })
    expect(res.checks.find((c) => c.id === 'signed_by_sender')).toMatchObject({
      ok: false,
      message: 'Signed "mdelgado", not your name "Marcus Delgado".',
    })
  })

  it('fails "as we discussed" with no history and allows it with history', () => {
    const body = GOOD_BODY.replace('I built', 'As we discussed, I built')
    expect(failing({ ...base, body })).toEqual(['no_invented_history'])
    expect(failing({ ...base, body, hasHistory: true })).toEqual([])
  })

  it('fails a banned phrase', () => {
    expect(failing({ ...base, body: GOOD_BODY.replace('I built', 'I am passionate about payments. I built') })).toEqual(['banned_phrases'])
  })

  it('checks the greeting against the contact', () => {
    expect(failing({ ...base, body: GOOD_BODY.replace('Hi Jane,', 'Hi Sam,') })).toEqual(['greeting'])
    expect(failing({ ...base, body: GOOD_BODY.replace('Hi Jane,', 'Hi there,'), contactName: null })).toEqual([])
    expect(failing({ ...base, body: GOOD_BODY.replace('Hi Jane,', 'Dear Jane,') })).toEqual(['greeting'])
    expect(failing({ ...base, contactName: null })).toEqual(['greeting'])
  })

  it('requires the company to be named', () => {
    expect(failing({ ...base, subject: 'Quick note', body: GOOD_BODY.replace(/Ramp/g, 'your team') })).toEqual(['names_company'])
  })

  it('requires a follow-up to be shorter than the first email', () => {
    const previousBody = `${GOOD_BODY}\n${'more words '.repeat(5)}`
    const short = ['Hi Jane,', '', 'The payments role at Ramp is still open on my side. Would you be open to pointing me to the right person?', '', 'Thanks,', 'Marcus Delgado'].join('\n')
    expect(failing({ ...base, kind: 'follow_up', body: short, previousBody, hasHistory: true })).toEqual([])
    expect(failing({ ...base, kind: 'follow_up', body: previousBody, previousBody, hasHistory: true })).toContain('word_count')
  })

  it('holds a cover letter to its tier', () => {
    const letter = (n: number) => `Dear Ramp team,\n${'word '.repeat(n)}`
    expect(failing({ kind: 'cover_letter', body: letter(380), tier: 'focused', companyName: 'Ramp' })).toEqual(['word_count'])
    expect(failing({ kind: 'cover_letter', body: letter(180), tier: 'focused', companyName: 'Ramp' })).toEqual([])
    expect(failing({ kind: 'cover_letter', body: letter(30), tier: 'brief', companyName: 'Ramp' })).toEqual(['word_count'])
  })

  it('counts each asking sentence once', () => {
    expect(countAsks('Would you be open to a chat? Could you point me to someone?')).toBe(2)
    expect(countAsks('Could you tell me who is the right person?')).toBe(1)
  })
})

describe('browser safety', () => {
  it('uses no regex lookbehind, a parse-time SyntaxError on Safari before 16.4 that would take the card down', () => {
    for (const file of ['checks.ts', 'banned.ts']) {
      const src = readFileSync(join(process.cwd(), 'lib', 'writing', file), 'utf8')
      expect(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), file).not.toMatch(/\(\?<[=!]/)
    }
  })
})
