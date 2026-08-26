// Guards on the two things about this contract that break silently.
//
// WHY THIS TEST LIVES HERE and not beside the components it renders: it is
// about contract.ts — what may cross from this server module into a browser
// bundle, and whether the components that consume it still stand up.
//
// react-dom/server, because vitest.config.ts configures no jsdom environment
// (see components/layout/header.test.tsx). Effects never run, so both
// components render their loading state and neither touches the network.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccessCodeActivity } from '@/components/settings/access-code-activity'
import { AccessCodesCard } from '@/components/settings/access-codes-card'

const CLIENT_FILES = [
  'components/settings/access-codes-card.tsx',
  'components/settings/access-code-activity.tsx',
]

function source(relative: string): string {
  return readFileSync(path.resolve(__dirname, '../../..', relative), 'utf8')
}

describe('contract.ts stays out of the browser bundle', () => {
  it.each(CLIENT_FILES)('%s imports the contract as types only', (file) => {
    // contract.ts transitively imports node:crypto via lib/access/codes.ts. A
    // VALUE import from a 'use client' component would drag crypto into the
    // browser bundle and break the build — and the failure would surface as an
    // opaque webpack error a long way from this line. `import type` is erased
    // at compile time, so it is the only safe form.
    const text = source(file)
    const importsContract = /from '@\/app\/api\/access-codes\/contract'/.test(text)
    expect(importsContract).toBe(true)
    expect(text).toMatch(/import type \{[^}]*\} from '@\/app\/api\/access-codes\/contract'/)
    expect(text).not.toMatch(/^import \{[^}]*\} from '@\/app\/api\/access-codes\/contract'/m)
  })
})

describe('the owner-facing components render', () => {
  it('the card leads with the create control and a loading list', () => {
    const html = renderToStaticMarkup(createElement(AccessCodesCard, {}))
    expect(html).toContain('Create demo code')
    // Every list has a loading state that says so out loud, not just skeletons.
    expect(html).toContain('Loading your access codes')
    // The plaintext code panel is never part of the first paint — it exists
    // only in the response to a create request.
    expect(html).not.toContain('will not be shown again')
  })

  it('the activity timeline names the code it belongs to while loading', () => {
    const html = renderToStaticMarkup(
      createElement(AccessCodeActivity, { codeId: 'c1', codeName: 'Acme demo' })
    )
    expect(html).toContain('Loading activity for Acme demo')
  })
})
