'use client'

// The mobile-only top bar.
//
// WHY THERE IS NO DESKTOP HEADER ANY MORE
//   At `md`+ this band held nothing but an avatar pinned right — 56px of empty
//   chrome on every page. Two attempts were made to justify it: a page title
//   (which duplicated each page's own h1 on four routes and contradicted it on
//   two, because nav-items.ts names SECTIONS for a person's day — "Opportunities",
//   "Applications" — while pages keep literal names, "Jobs", "Pipeline"), then a
//   section breadcrumb (which on a section root just restated the page you were
//   already looking at). Having failed twice to earn its height, the band is
//   gone: the desktop shell is now a full-height left rail plus content, and the
//   account menu that used to live here moved to the foot of that rail.
//
//   It survives below `md` for one reason. The six contextual sub-destinations
//   (Notifications, Companies, Needs you, Interview prep, Contacts, Insights)
//   exist only inside the mobile drawer, and this hamburger is the drawer's only
//   opener — MobileNav's bottom bar carries just the five primary routes. Remove
//   this and a third of the app becomes unreachable on a phone.

import type { RefObject } from 'react'
import { Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface HeaderProps {
  /** Opens the mobile nav drawer (see sidebar.tsx). */
  onOpenNav: () => void
  /** So the drawer can return focus to the control that opened it on close. */
  menuButtonRef: RefObject<HTMLButtonElement>
}

export function Header({ onOpenNav, menuButtonRef }: HeaderProps) {
  return (
    // `md:hidden` on the element itself, so at desktop widths it is display:none
    // and contributes zero height to the flex column in layout.tsx — <main>
    // simply gets the whole viewport.
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:hidden">
      <Button
        ref={menuButtonRef}
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={onOpenNav}
        aria-label="Open navigation menu"
        aria-haspopup="true"
      >
        <Menu className="h-[18px] w-[18px]" />
      </Button>
    </header>
  )
}
