import Link from 'next/link'
import { Briefcase, Building2, KanbanSquare, LayoutDashboard, MessageSquare, type LucideIcon } from 'lucide-react'
import { chat, conversations, phoneTabs, today, isCurrent } from '@/lib/routes'

const ICON: Record<string, LucideIcon> = {
  Today: LayoutDashboard,
  Roles: Briefcase,
  Companies: Building2,
  Applications: KanbanSquare,
  Conversations: MessageSquare,
  Chat: MessageSquare,
}

// The phone's bottom plinth: five tabs, the current one a key. It is a normal
// flex child at the foot of the column (not fixed), so the page above it never
// scrolls underneath it. The tab height is 44px or more.
export function PhoneTabs({ pathname, needsYou, chatOpen = false }: { pathname: string; needsYou?: number; chatOpen?: boolean }) {
  return (
    <nav
      aria-label="Bottom navigation"
      className="r-plinth-tabs flex shrink-0 gap-1 px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
    >
      {phoneTabs.map((r) => (r === chat && !chatOpen ? conversations : r)).map((r) => {
        const Icon = ICON[r.label] ?? LayoutDashboard
        return (
          <Link
            key={r.href}
            href={r.href}
            aria-current={isCurrent(pathname, r.href) ? 'page' : undefined}
            className="r-tabkey flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-1.5 text-[11px] font-medium tracking-tight"
          >
            <Icon className="h-5 w-5" aria-hidden />
            <span>
              {r.label}
              {r.href === today.href && needsYou ? (
                <span className="ml-1 font-semibold text-r-copper-text">{needsYou}</span>
              ) : null}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
