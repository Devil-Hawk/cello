// Closed roles leave the Roles list but an old link to one still opens. The pages read
// through the person's own rows, so this pins the two queries in their source: the For
// you list carries the open filter, the record loaded by id does not.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const list = readFileSync(path.join(process.cwd(), 'app/(app)/roles/read.ts'), 'utf8')
const record = readFileSync(path.join(process.cwd(), 'app/(app)/roles/[id]/read.ts'), 'utf8')

describe('Roles and closed roles', () => {
  it('the For you list keeps open and unknown roles only', () => {
    // openRolesOnly (lib/jobs/freshness.ts): posted inside 180 days or undated, and not closed (still_open is not false).
    const forYou = list.slice(list.indexOf("if (q.tab === 'for-you') {"))
    expect(forYou.slice(0, 200)).toContain('openRolesOnly(on)')
    expect(readFileSync(path.join(process.cwd(), 'lib/jobs/freshness.ts'), 'utf8')).toContain("not(`${prefix}still_open`, 'is', false)")
  })

  it('the record by id still opens a closed role, and Saved still lists one', () => {
    expect(record).not.toContain('openRolesOnly')
    expect(record).not.toContain("'still_open', 'is'")
    const at = list.indexOf("else if (q.tab === 'saved')")
    expect(at).toBeGreaterThan(-1)
    expect(list.slice(at, at + 120)).not.toContain('openRolesOnly')
  })
})
