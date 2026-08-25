'use client'

// Persistent bottom tab bar for small screens — the phone equivalent of the
// sidebar rail. Below `md` (768px — the same threshold Sidebar's own rail
// vs. drawer split uses, and the one useIsMobile in components/copilot/hooks
// reads via `(max-width: 767px)`), the rail is display:none and the only way
// to move between pages was the hamburger drawer (see Header + Sidebar).
// That's a full menu, not a home base: this gives the five destinations from
// the target IA (Dashboard/Jobs/Pipeline/Copilot/Settings ->
// Today/Opportunities/Applications/Copilot/Settings — see the product
// review's five-destination model) one-tap reach, with the drawer still
// there for everything else.
//
// LAYOUT: rendered as a normal (non-fixed) flex child, last in the header/
// main/nav column in layout.tsx, with `shrink-0`. That makes the browser's
// flexbox layout — not a fixed-position overlay plus a guessed padding
// offset — the thing that reserves its space: `<main>` (flex-1,
// overflow-y-auto) simply has that much less height to fill, so its own
// scrollable content, and any page's own sticky/bottom-fixed elements within
// it, can never end up underneath this bar. "Reserve space, don't overlay
// and hope."
//
// PARITY: icons and labels are read straight out of navItems, the sidebar's
// own source of truth, so the two surfaces can never drift out of sync for
// the same route. Active state uses the identical isActive test the sidebar
// uses (exact match or a path segment beneath it) and sets aria-current the
// same way. The landmark itself gets a distinct label ("Bottom navigation"
// vs. the rail/drawer's "Primary") — not to rename any *item*, but because
// both this bar and the drawer can be on screen at once (drawer is an
// overlay, not exclusive with this bar), and two landmarks both named
// "Primary" at the same time would be a confusing duplicate for anyone
// navigating by landmark.
//
// No positive tabIndex, no custom focus styling needed — plain <Link>s pick
// up the global `*:focus-visible` ring from globals.css, same as every other
// nav link in the app.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { navItems, type NavItem } from '@/components/layout/nav-items'

const MOBILE_NAV_HREFS = ['/dashboard', '/jobs', '/pipeline', '/copilot', '/settings'] as const

const mobileNavItems: NavItem[] = MOBILE_NAV_HREFS.map((href) =>
  navItems.find((item) => item.href === href)
).filter((item): item is NavItem => Boolean(item))

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Bottom navigation"
      className="flex shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {mobileNavItems.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
        const Icon = item.icon

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname === item.href ? 'page' : undefined}
            className={cn(
              // min-h-11 (44px) is the tap-target floor; the five items
              // split the full viewport width between them, so width is
              // never the constraint at any phone size.
              'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-label font-medium transition-colors',
              // Colour alone isn't a safe differentiator (WCAG 1.4.1) — active
              // also goes bold (font-semibold overrides the base font-medium)
              // so the tab reads as selected even without hue perception.
              isActive ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
