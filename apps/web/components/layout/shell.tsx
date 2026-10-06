import type { ReactNode } from 'react'
import { Bar } from '@/components/layout/bar'
import { PhoneHead } from '@/components/layout/phone-head'
import { PhoneTabs } from '@/components/layout/phone-tabs'
import { QuickChatSlot } from '@/components/layout/quick-chat-slot'
import type { ShellUser } from '@/components/layout/account-menu'

export interface ShellProps {
  pathname: string
  user: ShellUser
  onSignOut: () => void
  needsYou?: number
  /** The notification bell stays in the bar until Today replaces it. Fixtures turn it off. */
  bell?: boolean
  children: ReactNode
}

// The whole signed-in chrome as one pure component: a skip link, the bar (or
// the phone's head and tabs), the page, and the quick chat slot. Auth, the
// first-run redirect and the page transition stay in app/(app)/layout.tsx.
export function Shell({ pathname, user, onSignOut, needsYou, bell = true, children }: ShellProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-r-ground font-r text-r-ink">
      {/* Keyboard-only skip link: the first tab stop, past the bar to the page. */}
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-[200] focus-visible:rounded-r-key focus-visible:bg-r-raised focus-visible:px-4 focus-visible:py-2 focus-visible:text-r-ink focus-visible:shadow-r-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-r-ink"
      >
        Skip to main content
      </a>
      <Bar pathname={pathname} user={user} onSignOut={onSignOut} needsYou={needsYou} bell={bell} />
      <PhoneHead user={user} onSignOut={onSignOut} bell={bell} />
      {/* No max-width here: width is the page's decision, so the kanban board and
          the jobs table keep the full width until their pages move over. */}
      <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none focus-visible:ring-0">
        <div className="mx-auto w-full px-4 py-5 sm:px-6 sm:py-6 md:px-8 md:py-8">{children}</div>
      </main>
      <PhoneTabs pathname={pathname} needsYou={needsYou} />
      <QuickChatSlot />
    </div>
  )
}
