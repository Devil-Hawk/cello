import Link from 'next/link'
import { Mark } from '@/components/depth/mark'
import { Key } from '@/components/ui/key'
import { Plinth } from '@/components/ui/plinth'
import { AccountMenu, type ShellUser } from '@/components/layout/account-menu'
import { DueDot } from '@/components/network/dot'
import { ThemeKey } from '@/components/layout/theme-key'
import { barRoutes, chat, isCurrent, network, today } from '@/lib/routes'

export interface BarProps {
  pathname: string
  user: ShellUser
  onSignOut: () => void
  /** Today's copper numeral. Absent until the Needs you count exists. */
  needsYou?: number
  /** Pages with a dot: today only Network, when a follow-up is due. */
  dots?: { network?: boolean }
}

// The laptop bar: a raised plinth on the ground with the Cello mark, a key per
// page, and the person's own things at the right. The current page is a key
// standing 1px proud. Roles come before Companies, each a page of its own.
export function Bar({ pathname, user, onSignOut, needsYou, dots }: BarProps) {
  return (
    <header className="relative z-40 hidden shrink-0 px-6 py-3 md:block">
      <Plinth className="mx-auto flex h-14 max-w-[1200px] items-center gap-2 pl-3 pr-2">
        <Link href={today.href} aria-label="Cello, Today" className="mr-2 flex items-center gap-2.5 rounded-[12px]">
          <Mark size={36} />
          <span className="r-title" aria-hidden>
            Cello
          </span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-1">
          {barRoutes.map((r) => (
            <Key key={r.href} asChild variant="ghost" current={isCurrent(pathname, r.href)}>
              <Link href={r.href}>
                {r.label}
                {r.href === today.href && needsYou ? (
                  <span className="ml-1.5 font-semibold text-r-copper-text">{needsYou}</span>
                ) : null}
                {r.href === network.href && dots?.network ? <DueDot className="ml-1.5" /> : null}
              </Link>
            </Key>
          ))}
        </nav>
        <span className="flex-1" />
        {chat.bar && (
          <Key asChild variant="raised" current={isCurrent(pathname, chat.href)}>
            <Link href={chat.href}>{chat.label}</Link>
          </Key>
        )}
        <ThemeKey />
        <AccountMenu user={user} onSignOut={onSignOut} dots={dots} />
      </Plinth>
    </header>
  )
}
