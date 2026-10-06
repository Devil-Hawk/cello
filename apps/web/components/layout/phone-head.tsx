import Link from 'next/link'
import { MarkTwin } from '@/components/depth/twins'
import { AccountMenu, type ShellUser } from '@/components/layout/account-menu'
import { NotificationBell } from '@/components/layout/notification-bell'
import { ThemeKey } from '@/components/layout/theme-key'
import { today } from '@/lib/routes'

// The phone's head: the mark as its SVG (no canvas on a phone's first screen),
// then the person's own things. The pages live in the bottom tabs.
export function PhoneHead({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  return (
    <header className="flex shrink-0 items-center gap-1 px-4 pb-1 pt-3 md:hidden">
      <Link href={today.href} aria-label="Cello, Today" className="mr-auto flex min-h-11 items-center rounded-[12px]">
        <MarkTwin size={28} />
      </Link>
      <NotificationBell side="bottom" align="end" />
      <ThemeKey />
      <AccountMenu user={user} onSignOut={onSignOut} />
    </header>
  )
}
