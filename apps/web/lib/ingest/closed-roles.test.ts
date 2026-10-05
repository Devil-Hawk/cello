// Closed roles leave the Jobs list but an old link to one still opens. The page
// is a client component with no seam to render in a unit test, so this pins the
// two queries in its source: the list carries the open filter, the deep link
// by id does not.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.join(process.cwd(), 'app/(app)/jobs/page.tsx'), 'utf8')

describe('Jobs page and closed roles', () => {
  it('the list query keeps open and unknown roles only', () => {
    // openRolesOnly (lib/jobs/freshness.ts): posted inside 180 days or undated, and not closed (still_open is not false).
    const withFacets = source.slice(source.indexOf('const withFacets'))
    expect(withFacets.slice(0, 400)).toContain('openRolesOnly(start)')
    expect(readFileSync(path.join(process.cwd(), 'lib/jobs/freshness.ts'), 'utf8')).toContain("not(`${prefix}still_open`, 'is', false)")
  })

  it('the deep link by id still opens a closed role', () => {
    const start = source.indexOf(".eq('id', deepLinkJobId)")
    const deep = source.slice(start - 300, start + 100)
    expect(deep).not.toContain('still_open')
  })
})
