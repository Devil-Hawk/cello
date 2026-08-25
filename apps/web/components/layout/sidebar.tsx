'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun, X } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Logo } from '@/components/brand/logo'
import { cn, getInitials } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AnimatePresence, motion, transitionFast } from '@/components/ui/motion'
import { navItems, type NavItem, type NavSubItem } from '@/components/layout/nav-items'

/** Local storage key for the desktop rail's collapse state (see isCollapsed
 *  below) — namespaced so it can't collide with any other persisted UI
 *  preference the app adds later. */
const SIDEBAR_COLLAPSED_KEY = 'cello:sidebar-collapsed'

interface SidebarProps {
  /** Rendered in the account row at the foot of the rail/drawer — the same
   *  shape Header used to take before the account menu moved here. */
  user: {
    email: string
    fullName: string | null
    avatarUrl: string | null
  }
  onSignOut: () => void
  /**
   * True while the off-canvas mobile drawer (below the `md` breakpoint) is
   * open. The desktop rail below always renders (hidden md:flex) and is
   * unaffected by this — it's a separate, always-mounted element from the
   * drawer, which only mounts while open. Owned by layout.tsx, the shared
   * parent of this component and the Header hamburger button that opens it.
   */
  isMobileOpen?: boolean
  /** Closes the drawer AND returns focus to the hamburger button that opened
   *  it (layout.tsx wires this) — see job-detail-modal.tsx for the same
   *  focus-restore pattern applied to a Dialog instead of this drawer. */
  onCloseMobile?: () => void
}

export function Sidebar({ user, onSignOut, isMobileOpen = false, onCloseMobile }: SidebarProps) {
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  // Starts false unconditionally — reading localStorage during render would
  // make server and first-paint client markup disagree (SSR has no
  // localStorage). The effect below reconciles it right after mount, so the
  // only cost is a one-frame flash to collapsed for a user who left it that
  // way, not a hydration mismatch.
  const [isCollapsed, setIsCollapsedState] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') {
      setIsCollapsedState(true)
    }
  }, [])

  function setIsCollapsed(value: boolean) {
    setIsCollapsedState(value)
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value))
    } catch {
      /* Private browsing / storage disabled — collapse state just won't
       * survive a reload, which is exactly the behaviour before this was
       * added. Not worth surfacing to the user. */
    }
  }

  // While the mobile drawer is open: lock background scroll, move focus
  // into it (the close button — the first sensible stop), and let Escape
  // close it no matter which nav item inside currently has focus. None of
  // this ever runs on the desktop rail (isMobileOpen stays false there).
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isMobileOpen) return
    const previousOverflow = document.body.style.overflow
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseMobile?.()
        return
      }
      if (event.key !== 'Tab') return

      // Focus trap. Queried on every Tab rather than once on open, because the
      // drawer's contents change as sections expand — a list captured at open
      // time would let focus escape through anything rendered afterwards.
      const root = drawerRef.current
      if (!root) return
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null

      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      // Send focus back where it came from; otherwise closing the drawer drops
      // the user at the top of the document.
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [isMobileOpen, onCloseMobile])

  /** Exact-match-or-descendant test shared by primary items and sub-items. */
  function isRouteActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  function renderSubItem(sub: NavSubItem, onNavigate?: () => void) {
    // Two different questions: `active` drives the highlight and is true for
    // descendants (/companies/abc still sits under Companies); `isCurrentPage`
    // drives aria-current and must be exact, or a screen reader is told a link
    // is the current page when following it would navigate away.
    const active = isRouteActive(sub.href)
    const isCurrentPage = pathname === sub.href
    const SubIcon = sub.icon
    return (
      <Link
        href={sub.href}
        aria-current={isCurrentPage ? 'page' : undefined}
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-caption font-medium transition-colors',
          active
            ? 'bg-sunken text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <SubIcon className="h-[15px] w-[15px] flex-shrink-0" />
        {sub.label}
      </Link>
    )
  }

  function renderPrimaryItem(item: NavItem, collapsed: boolean, onNavigate?: () => void) {
    // NOT exact despite the old name — isRouteActive matches descendants too,
    // which is what silently put aria-current on the wrong link.
    const inSection = isRouteActive(item.href)
    const isCurrentPage = pathname === item.href
    // A sub-item can be the current page without the parent itself being
    // one — e.g. on /queue, "Applications" isn't literally the current
    // page (so no aria-current there), but it should still read as the
    // current *section* so the rail doesn't look like you've left it.
    const sectionActive =
      inSection || (item.subItems?.some((sub) => isRouteActive(sub.href)) ?? false)
    const Icon = item.icon

    const link = (
      <Link
        href={item.href}
        aria-current={isCurrentPage ? 'page' : undefined}
        aria-label={collapsed ? item.label : undefined}
        onClick={onNavigate}
        className={cn(
          'group/navlink relative flex items-center gap-3 rounded-control px-3 py-2 text-body font-medium transition-colors',
          inSection
            ? 'bg-sunken text-foreground'
            : sectionActive
              ? 'text-foreground hover:bg-muted'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-foreground/40 transition-all',
            inSection
              ? 'opacity-100'
              : sectionActive
                ? 'opacity-40'
                : 'opacity-0 group-hover/navlink:opacity-40'
          )}
        />
        <Icon className="h-[18px] w-[18px] flex-shrink-0" />
        {!collapsed && item.label}
      </Link>
    )

    const primary = collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {item.label}
        </TooltipContent>
      </Tooltip>
    ) : (
      link
    )

    return (
      <div key={item.href}>
        {primary}
        {/* Contextual sub-destinations (e.g. Notifications under Today,
            Companies under Opportunities). Only ever shown in the expanded
            rail/drawer — the collapsed icon rail stays exactly as it was,
            one icon per primary destination. Everything nested here still
            has its own working route; this is a navigation affordance, not
            the only way in (most also have in-page inbound links). */}
        {!collapsed && item.subItems && item.subItems.length > 0 && (
          <ul className="mt-1 space-y-0.5 border-l border-border pl-[18px]">
            {item.subItems.map((sub) => (
              <li key={sub.href}>{renderSubItem(sub, onNavigate)}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  /**
   * Account row: avatar + name/email + sign-out, formerly Header's
   * top-right corner. Moved here whole (same aria-label, Avatar,
   * getInitials, sign-out item) because the header band it lived in is
   * gone at md+ — see header.tsx for why. Rendered twice (expanded rail,
   * mobile drawer — both `collapsed=false`) and once more collapsed, the
   * same one-function-two-call-sites shape as renderPrimaryItem above, so
   * a `<DropdownMenu>` root is never shared between two mounted triggers.
   *
   * The theme toggle that used to live beside sign-out in Header's dropdown
   * stays inside this dropdown rather than becoming its own icon button
   * next to the collapse toggle: the collapsed rail's foot is only 68px
   * wide, and a third icon there (account, theme, collapse) would either
   * wrap to two rows or shrink tap targets below 44px. Keeping it as a menu
   * item is also the smaller diff on a control that already worked.
   */
  function renderAccountRow(collapsed: boolean) {
    const trigger = (
      <button
        type="button"
        aria-label={`Account menu for ${user.fullName || user.email}`}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-control py-1.5 text-left transition-colors hover:bg-muted',
          collapsed ? 'justify-center px-0' : 'px-2'
        )}
      >
        <Avatar className="h-8 w-8 shrink-0">
          {user.avatarUrl && (
            <AvatarImage src={user.avatarUrl} alt={user.fullName || 'User'} />
          )}
          <AvatarFallback className="text-caption">
            {getInitials(user.fullName || user.email)}
          </AvatarFallback>
        </Avatar>
        {/* Truncates independently of the avatar so a long Google display
            name or a long address can never push the rail wider than its
            fixed 240px (w-60) — min-w-0 on the flex item is what lets
            truncate actually clip instead of overflowing the row. */}
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-caption font-medium text-foreground">
              {user.fullName || 'User'}
            </span>
            <span className="block truncate text-label text-muted-foreground">
              {user.email}
            </span>
          </span>
        )}
      </button>
    )

    // side="right" + align="end": opens to the right of the rail (never
    // squeezed against the left edge of the viewport) with its bottom edge
    // pinned to the trigger's bottom edge, so the menu grows upward from a
    // trigger that sits at the very foot of the screen instead of trying to
    // render below it and off the bottom of the viewport.
    const content = (
      <DropdownMenuContent className="w-56" side="right" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-body font-medium leading-none text-foreground">
              {user.fullName || 'User'}
            </p>
            <p className="text-caption leading-none text-muted-foreground">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer"
          onSelect={(event) => {
            event.preventDefault()
            setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
          }}
        >
          <Sun className="mr-2 h-4 w-4 dark:hidden" />
          <Moon className="mr-2 hidden h-4 w-4 dark:block" />
          <span className="dark:hidden">Dark mode</span>
          <span className="hidden dark:inline">Light mode</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          onClick={onSignOut}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    )

    if (collapsed) {
      // Same Tooltip-wraps-trigger pattern as the collapsed nav icons above,
      // so the account row stays identifiable by name on hover/focus even
      // with no visible label — nested inside the DropdownMenu root (rather
      // than the other way around) because Radix's Tooltip already closes
      // itself on pointer-down, so opening the menu doesn't leave a stale
      // tooltip bubble behind it.
      return (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-medium">
              {user.fullName || user.email}
            </TooltipContent>
          </Tooltip>
          {content}
        </DropdownMenu>
      )
    }

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        {content}
      </DropdownMenu>
    )
  }

  return (
    <TooltipProvider delayDuration={0}>
      {/* Desktop rail: always mounted at md+ (`hidden md:flex`), collapsible
          via the button at its foot. Never shown below md — the drawer
          below is the mobile equivalent, so the two never overlap. */}
      <aside
        className={cn(
          'relative hidden h-screen flex-col border-r bg-card transition-all duration-300 md:flex',
          isCollapsed ? 'w-[68px]' : 'w-60'
        )}
      >
        {/* Wordmark */}
        <div className="flex h-14 items-center gap-2 px-5">
          <Link
            href="/dashboard"
            className="flex items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Cello — go to Today"
          >
            {/* The mark is aria-hidden, so the link carries the name itself —
                otherwise the collapsed sidebar would be an unlabelled link. */}
            <Logo showWordmark={!isCollapsed} />
          </Link>
        </div>

        {/* Five destinations, each with its contextual sub-items nested
            beneath it (see nav-items.ts for the full mapping). */}
        <nav aria-label="Primary" className="flex-1 space-y-2 overflow-y-auto px-3 py-4 scrollbar-thin">
          {navItems.map((item) => renderPrimaryItem(item, isCollapsed))}
        </nav>

        {/* Account + collapse toggle. Account sits above the toggle rather
            than beside it — at 68px collapsed width there isn't room for
            two icon-sized controls side by side without shrinking one below
            the 44px touch-target floor. */}
        <div className="space-y-1 border-t px-3 py-3">
          {renderAccountRow(isCollapsed)}
          {isCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-full text-muted-foreground"
                  onClick={() => setIsCollapsed(false)}
                  aria-label="Expand sidebar"
                  aria-expanded={!isCollapsed}
                >
                  <PanelLeftOpen className="h-[18px] w-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="font-medium">
                Expand
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={() => setIsCollapsed(true)}
              aria-label="Collapse sidebar"
              aria-expanded={!isCollapsed}
            >
              <PanelLeftClose className="h-[18px] w-[18px]" />
            </Button>
          )}
        </div>
      </aside>

      {/* Mobile drawer: below md, the sidebar is off-canvas by default and
          opened via the hamburger button in Header (see layout.tsx). Only
          mounted while open — closed, it is not just visually hidden but
          entirely absent from the DOM, so it can never be tabbed into or
          seen by assistive tech, no separate inert/aria-hidden bookkeeping
          required. Always renders expanded (collapsed=false) regardless of
          the desktop rail's own collapse state — "collapsed" is a
          desktop-icon-rail concept that doesn't apply to a full-width
          overlay drawer. */}
      {/* Two separate AnimatePresence blocks (rather than one wrapping a
          Fragment of two motion elements) — each gets exactly one
          conditionally-rendered child, the shape framer-motion's exit
          animations reliably track. */}
      <AnimatePresence>
        {isMobileOpen && (
          <motion.div
            key="sidebar-backdrop"
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitionFast}
            onClick={onCloseMobile}
            aria-hidden
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isMobileOpen && (
          <motion.aside
            key="sidebar-drawer"
            ref={drawerRef}
                role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="fixed inset-y-0 left-0 z-50 flex h-screen w-72 max-w-[85vw] flex-col border-r bg-card shadow-pop md:hidden"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={transitionFast}
          >
            <div className="flex h-14 items-center justify-between gap-2 px-4">
              <Link
                href="/dashboard"
                className="flex items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onCloseMobile}
                aria-label="Cello — go to Today"
              >
                <Logo />
              </Link>
              <Button
                ref={closeButtonRef}
                variant="ghost"
                size="icon"
                onClick={onCloseMobile}
                aria-label="Close navigation menu"
              >
                <X className="h-[18px] w-[18px]" />
              </Button>
            </div>

            <nav
              aria-label="Primary"
              className="flex-1 space-y-2 overflow-y-auto px-3 py-4 scrollbar-thin"
            >
              {navItems.map((item) => renderPrimaryItem(item, false, onCloseMobile))}
            </nav>

            {/* Account row, drawer foot. The header's avatar/sign-out menu
                is gone below md too (Header renders only the hamburger
                there now), so without this a phone user would have no way
                to sign out at all. Always the expanded (collapsed=false)
                variant — same reasoning as the nav items just above. */}
            <div className="border-t px-3 py-3">{renderAccountRow(false)}</div>
          </motion.aside>
        )}
      </AnimatePresence>
    </TooltipProvider>
  )
}
