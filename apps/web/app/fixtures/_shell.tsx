'use client'

import type { ReactNode } from 'react'
import { Shell } from '@/components/layout/shell'

// The signed-in chrome on a made-up person, for fixture pages that are server
// components. Only the chrome is a client component; the page it wraps stays on the
// server as it does in the app, so a fixture weighs what the real page weighs.
export function FixtureShell({ pathname, children }: { pathname: string; children: ReactNode }) {
  return (
    <Shell pathname={pathname} user={{ email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }} onSignOut={() => undefined}>
      {children}
    </Shell>
  )
}
