// The card must never claim a watch that is off. It renders its status line
// from the STORED grant + token presence the parent fetched via
// GET /api/gmail/permissions (see the component's own header) — this pins
// each of the three honest states to concrete rendered text.
//
// renderToStaticMarkup, not a DOM renderer: no jsdom is configured in
// vitest.config.ts, and the initial render (isSyncing=false, result=null)
// holds no state this test needs to interact with — same approach as
// components/queue/handoff-card.test.tsx.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ComponentProps } from 'react'
import { GmailSyncCard } from './gmail-sync-card'

function render(props: Partial<ComponentProps<typeof GmailSyncCard>> = {}): string {
  return renderToStaticMarkup(createElement(GmailSyncCard, props))
}

describe('GmailSyncCard — three honest states', () => {
  it('monitoring off: says so plainly and offers a CTA to turn it on', () => {
    const html = render({ monitor: false, backgroundReady: false, lastSyncAt: null })
    expect(html).toContain('Inbox monitoring is off')
    expect(html).toContain('Turn on Gmail monitoring in Settings')
    expect(html).not.toContain('Last synced')
  })

  it('monitoring on but no background token: says background sync cannot run yet, offers Reconnect', () => {
    const html = render({ monitor: true, backgroundReady: false, lastSyncAt: null })
    expect(html).toContain('background sync needs a fresh Google sign-in')
    expect(html).toContain('Reconnect Gmail in Settings')
  })

  it('a stored grant with no background token is never rendered as fully on, even with a stale lastSyncAt lying around', () => {
    // Regression guard for the exact live bug this step fixes: a grant that
    // reads enabled with nothing to exchange it for must never be shown as
    // "Last synced ..." just because some earlier sync happened once.
    const html = render({ monitor: true, backgroundReady: false, lastSyncAt: '2026-08-01T00:00:00.000Z' })
    expect(html).not.toContain('Last synced')
    expect(html).toContain('Reconnect Gmail in Settings')
  })

  it('fully on with a prior sync: shows when it last ran, no CTA', () => {
    const html = render({ monitor: true, backgroundReady: true, lastSyncAt: '2026-08-20T00:00:00.000Z' })
    expect(html).toContain('Last synced')
    expect(html).not.toContain('in Settings')
  })

  it('fully on, never synced yet: says so instead of a false "Last synced"', () => {
    const html = render({ monitor: true, backgroundReady: true, lastSyncAt: null })
    expect(html).toContain('the first sync')
    expect(html).toContain('run yet')
    expect(html).not.toContain('Last synced')
  })
})
