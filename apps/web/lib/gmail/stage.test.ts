// Tests for lib/gmail/stage.ts#classifyReply — the coarse-polarity mapping
// table for the STEP 5 outreach reply bridge. Bounce detection is checked
// FIRST (sender/subject), independent of whatever ApplicationStatus the
// job-application classifier attached to the same message.

import { describe, expect, it } from 'vitest'
import { classifyReply } from './stage'

describe('classifyReply', () => {
  it.each([
    ['applied', 'positive'],
    ['screen', 'positive'],
    ['interview', 'positive'],
    ['offer', 'positive'],
    ['accepted', 'positive'],
    ['rejected', 'negative'],
    ['unknown', 'neutral'],
  ] as const)('maps status %s -> %s', (status, expected) => {
    expect(classifyReply('jane@acme.com', 'Re: hello', status)).toBe(expected)
  })

  it('classifies a mailer-daemon sender as bounce regardless of status', () => {
    expect(classifyReply('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)', 'unknown')).toBe(
      'bounce'
    )
  })

  it('classifies a postmaster sender as bounce', () => {
    expect(classifyReply('postmaster@acme.com', 'undeliverable', 'applied')).toBe('bounce')
  })

  it('classifies an "undeliverable" subject as bounce even from a normal sender', () => {
    expect(classifyReply('jane@acme.com', 'Undeliverable: Following up', 'unknown')).toBe('bounce')
  })

  it('bounce detection wins over a positive-looking status', () => {
    expect(classifyReply('mailer-daemon@acme.com', 'Delivery Status Notification (Failure)', 'interview')).toBe('bounce')
  })
})
