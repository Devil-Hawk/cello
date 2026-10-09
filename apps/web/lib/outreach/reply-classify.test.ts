import { describe, expect, it } from 'vitest'
import type { LlmRunner } from '@/lib/harness/types'
import { classifyReplyPatterns, classifyReplyWith, isAutoReply, isBounce, stripQuoted } from './reply-classify'

const QUOTED = [
  'On Tue, Oct 6, 2026 at 9:00 AM Alex Candidate <alex@example.com> wrote:',
  '> Hi Jordan,',
  '> Would you be open to a chat about the payments role?',
  '> Thanks, Alex',
].join('\n')

describe('stripQuoted', () => {
  it('cuts at "On ... wrote:" and keeps only the reply', () => {
    expect(stripQuoted(`Happy to chat, are you free Tuesday?\n\n${QUOTED}`)).toBe('Happy to chat, are you free Tuesday?')
  })

  it('cuts at a wrapped "On ... wrote:" (Gmail wraps long headers)', () => {
    const wrapped = 'No thanks.\n\nOn Tue, Oct 6, 2026 at 9:00 AM Alex Candidate <alex@example.com>\nwrote:\n> Would you be open to a chat?'
    expect(stripQuoted(wrapped)).toBe('No thanks.')
  })

  it('cuts at quoted lines, an Original Message rule, and an Outlook From: block after a blank line', () => {
    expect(stripQuoted('Sounds good.\n> would you be open to a chat?')).toBe('Sounds good.')
    expect(stripQuoted('Sounds good.\n-----Original Message-----\nFrom: Alex')).toBe('Sounds good.')
    expect(stripQuoted('Sounds good.\n\nFrom: Alex Candidate\nSent: Tuesday\nSubject: hello')).toBe('Sounds good.')
  })

  it('leaves a reply with no quote alone', () => {
    expect(stripQuoted('Thanks, got it.')).toBe('Thanks, got it.')
  })
})

describe('isAutoReply', () => {
  const h = (name: string, value: string) => [{ name, value }]
  it('recognises the standard automatic-answer headers', () => {
    expect(isAutoReply(h('Auto-Submitted', 'auto-replied'), 'Re: hi')).toBe(true)
    expect(isAutoReply(h('X-Autoreply', 'yes'), 'Re: hi')).toBe(true)
    expect(isAutoReply(h('X-Autorespond', 'yes'), 'Re: hi')).toBe(true)
    expect(isAutoReply(h('Precedence', 'auto_reply'), 'Re: hi')).toBe(true)
  })

  it('recognises an out-of-office subject', () => {
    expect(isAutoReply([], 'Automatic reply: Staff Engineer at Acme')).toBe(true)
    expect(isAutoReply([], 'Out of office until Monday')).toBe(true)
    expect(isAutoReply([], 'Autoreply: hello')).toBe(true)
  })

  it('does not treat a human reply, or Auto-Submitted: no, as automatic', () => {
    expect(isAutoReply(h('Auto-Submitted', 'no'), 'Re: hi')).toBe(false)
    expect(isAutoReply([], 'Re: Staff Engineer at Acme')).toBe(false)
  })
})

describe('isBounce', () => {
  it('reads a delivery failure from the sender or the subject', () => {
    expect(isBounce('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'x')).toBe(true)
    expect(isBounce('jane@acme.com', 'Undeliverable: hello')).toBe(true)
    expect(isBounce('jane@acme.com', 'Re: hello')).toBe(false)
  })
})

describe('classifyReplyPatterns', () => {
  it('"Happy to chat, are you free Tuesday?" is positive', () => {
    expect(classifyReplyPatterns('Re: hello', 'Happy to chat, are you free Tuesday?')).toBe('positive')
  })

  it('"We are not hiring for this right now" is negative', () => {
    expect(classifyReplyPatterns('Re: hello', 'We are not hiring for this right now.')).toBe('negative')
  })

  it('"No thanks" above a quote that contains "would you be open to a chat" is negative', () => {
    expect(classifyReplyPatterns('Re: hello', stripQuoted(`No thanks.\n\n${QUOTED}`))).toBe('negative')
  })

  it('does not read the quoted original as the reply: a bare acknowledgement stays neutral', () => {
    expect(classifyReplyPatterns('Re: hello', stripQuoted(`Thanks, got it.\n\n${QUOTED}`))).toBe('neutral')
  })

  it('forwarding, asking for a resume and proposing a time are positive', () => {
    expect(classifyReplyPatterns('Re: hello', "I'll forward this to our recruiting lead.")).toBe('positive')
    expect(classifyReplyPatterns('Re: hello', 'Could you send me your resume?')).toBe('positive')
    expect(classifyReplyPatterns('Re: hello', 'Let me know, how about Monday?')).toBe('positive')
  })
})

function runner(answer: unknown): LlmRunner {
  return async () => ({ content: JSON.stringify(answer), tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'm' })
}

describe('classifyReplyWith', () => {
  it('keeps a model answer whose quote is in the reply', async () => {
    expect(await classifyReplyWith(runner({ classification: 'positive', evidence: 'are you free Tuesday' }), 'Re: hello', 'Happy to chat, are you free Tuesday?')).toBe('positive')
  })

  it('falls back to the patterns when the quote is not in the reply', async () => {
    expect(await classifyReplyWith(runner({ classification: 'positive', evidence: 'I would love to join your team' }), 'Re: hello', 'We are not hiring for this right now.')).toBe('negative')
  })

  it('falls back to the patterns when the model fails or answers with junk', async () => {
    const failing: LlmRunner = async () => {
      throw new Error('402')
    }
    expect(await classifyReplyWith(failing, 'Re: hello', 'We are not hiring for this right now.')).toBe('negative')
    const junk: LlmRunner = async () => ({ content: 'no json', tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'm' })
    expect(await classifyReplyWith(junk, 'Re: hello', 'Happy to chat, are you free Tuesday?')).toBe('positive')
  })

  it('never returns bounce from the model', async () => {
    expect(await classifyReplyWith(runner({ classification: 'bounce', evidence: 'delivery failed' }), 'x', 'Thanks, got it.')).toBe('neutral')
  })
})
