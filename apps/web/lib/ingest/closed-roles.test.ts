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
    const list = source.slice(source.indexOf("untyped.from('jobs').select(JOB_SELECT_COLUMNS"))
    expect(list.slice(0, 600)).toContain(".or('still_open.is.null,still_open.eq.true')")
  })

  it('the deep link by id still opens a closed role', () => {
    const start = source.indexOf(".eq('id', deepLinkJobId)")
    const deep = source.slice(start - 300, start + 100)
    expect(deep).not.toContain('still_open')
  })
})
