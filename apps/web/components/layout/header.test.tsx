// The mobile top bar carries two things now, and both are easy to regress in
// opposite directions: the bar must stay `md:hidden` (header.tsx explains at
// length why there is no desktop band any more — a bell is not a reason to
// bring 56px of chrome back to every desktop page), and it must carry the
// notification bell, since /notifications is no longer in the nav.
//
// react-dom/server, because vitest.config.ts configures no jsdom environment
// (see components/resume/resume-workspace.test.tsx). Effects do not run, so the
// bell renders its zero-state trigger and never touches Supabase — which is
// exactly the surface being asserted here.

import { describe, expect, it } from 'vitest'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Header } from './header'

function render(): string {
  return renderToStaticMarkup(
    createElement(Header, {
      onOpenNav: () => undefined,
      menuButtonRef: createRef<HTMLButtonElement>(),
    })
  )
}

describe('Header', () => {
  it('stays mobile-only', () => {
    expect(render()).toContain('md:hidden')
  })

  it('keeps the drawer opener', () => {
    expect(render()).toContain('aria-label="Open navigation menu"')
  })

  it('carries the notification bell, named for screen readers', () => {
    // Nothing has loaded at render time, so the label is the empty-state one.
    expect(render()).toContain('aria-label="Notifications — nothing new"')
  })
})
