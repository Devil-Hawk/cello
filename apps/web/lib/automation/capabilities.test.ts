// Guards the class of defect this module was created for: the UI claiming a
// capability the engine does not have. These are cheap and they fail loudly
// the moment the two sides drift apart again.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTO_SUBMIT_AVAILABLE, AUTO_SUBMIT_STATUS, autoSubmitEnabled } from './capabilities'

const root = process.cwd()

describe('auto-submit capability', () => {
  it('treats a legacy stored preference as off while the capability is off', () => {
    // Accounts created while onboarding offered the switch still carry
    // autoSubmit: true. Echoing that back is what told users applications were
    // going out when they were not.
    expect(autoSubmitEnabled(true)).toBe(AUTO_SUBMIT_AVAILABLE)
    expect(autoSubmitEnabled(false)).toBe(false)
    expect(autoSubmitEnabled(undefined)).toBe(false)
  })

  it('states what does happen rather than apologising for what does not', () => {
    expect(AUTO_SUBMIT_STATUS).toMatch(/approval/i)
  })

  it('keeps autopilot as an INDEPENDENT lock, not a reader of this flag', () => {
    // The unattended cron path must never submit, even if this module is
    // edited by mistake. If someone rewires autopilot to read the capability
    // constant, a single wrong edit could start firing irreversible
    // applications at real employers — so that wiring is forbidden outright.
    const autopilot = readFileSync(join(root, 'lib/harness/autopilot.ts'), 'utf8')
    expect(autopilot).toMatch(/const autoSubmit = false/)
    expect(autopilot).not.toMatch(/AUTO_SUBMIT_AVAILABLE/)
  })

  it('does not let onboarding offer a switch for an unavailable capability', () => {
    const onboarding = readFileSync(join(root, 'app/(app)/onboarding/page.tsx'), 'utf8')
    if (!AUTO_SUBMIT_AVAILABLE) {
      expect(onboarding).not.toMatch(/aria-label="Auto-submit applications"/)
      expect(onboarding).not.toMatch(/^\s*autoSubmit,$/m)
    }
  })
})
