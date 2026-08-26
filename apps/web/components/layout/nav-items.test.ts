// Guards the two navigation invariants a user reported as broken, both of
// which are invisible in review because they are absences: a route that has no
// entry, and an entry that should no longer be a route.
//
// The reported symptom, verbatim: "EVEN NO PLACE TO GO TO THE RESUME BUILDER
// OTHER THAN GOING TO A COMPANY PAGE" — /resume had no nav entry and the only
// link into the resume studio in the entire app was a button inside the job
// detail modal. And: "NOTIFICATION IS JUST NOTIFICATION IT DOESNT HAVE TO BE A
// PAGE" — it was spending a nav slot on three read-only lists.

import { describe, expect, it } from 'vitest'
import { navItems } from './nav-items'

/** Every href in the tree, primary and contextual alike. */
const allHrefs = navItems.flatMap((item) => [
  item.href,
  ...(item.subItems ?? []).map((sub) => sub.href),
])

describe('navItems', () => {
  it('offers the resume as a primary destination', () => {
    const resume = navItems.find((item) => item.href === '/resume')
    expect(resume, '/resume must be reachable from the sidebar').toBeDefined()
    expect(resume?.label).toBe('Resume')
  })

  it('does not spend a nav slot on /notifications', () => {
    // The ROUTE still exists and must keep working — this asserts only that it
    // is not in the rail. The glance lives in the bell popover instead (see
    // components/layout/notification-bell.tsx), which links back to the page.
    expect(allHrefs).not.toContain('/notifications')
  })

  it('names each destination once, at an absolute path', () => {
    expect(new Set(allHrefs).size).toBe(allHrefs.length)
    for (const href of allHrefs) {
      expect(href.startsWith('/')).toBe(true)
    }
  })
})
