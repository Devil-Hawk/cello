import {
  LayoutDashboard,
  Building2,
  Briefcase,
  KanbanSquare,
  Users,
  FileText,
  KeyRound,
  Settings,
  Inbox,
  Sparkles,
  GraduationCap,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'

/**
 * A contextual destination reached from a primary nav item, not a top-level
 * one itself. Every href below still resolves to a real, fully-functional
 * page — nothing was deleted or merged, these were just demoted out of the
 * primary rail so the app reads as five daily destinations instead of
 * eleven subsystems. See sidebar.tsx for how these render (indented, under
 * their parent, hidden only while the rail is collapsed to icons).
 */
export interface NavSubItem {
  href: string
  label: string
  icon: LucideIcon
}

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Contextual destinations nested under this primary item. Omitted where
   *  there are none (Today, Resume, Copilot). */
  subItems?: NavSubItem[]
}

/**
 * Single source of truth for primary app navigation (sidebar + mobile nav):
 * destinations organised around the user's day rather than the underlying
 * subsystems —
 *
 *   Today         /dashboard
 *   Opportunities /jobs        + Companies (watchlist / research context)
 *   Applications  /pipeline    + Needs you (queue), Interview prep,
 *                                Contacts, Insights (funnel + source stats)
 *   Resume        /resume
 *   Copilot       /copilot
 *   Settings      /settings    + Demo access (issue/revoke demo codes, and
 *                                read what was done with each one)
 *
 * Old subsystem-organised sections (Companies, Contacts, Prep, Queue,
 * Insights) are not gone — they're the `subItems` above, still real routes,
 * just reached as a sub-view of the destination they belong to now instead of
 * sitting in the primary rail themselves.
 *
 * WHY RESUME IS UP HERE
 *   It had no entry at all, and the ONLY link into the resume studio in the
 *   whole app was a button inside the job detail modal — so a user's own
 *   master document was reachable only by opening /jobs, opening a job, and
 *   clicking through, and the four templates behind it were effectively
 *   undiscoverable. /resume is now a real page (the base resume plus the
 *   list of jobs you can tailor for) and a primary destination, because
 *   maintaining your resume is a daily job-search activity, not a sub-view of
 *   one application.
 *
 * WHY NOTIFICATIONS IS NOT
 *   Three read-only lists you glance at and leave do not need a route in the
 *   rail. /notifications still EXISTS and still works — nothing about the page
 *   changed and every deep link into it resolves — but the glance now happens
 *   in the bell popover (components/layout/notification-bell.tsx), mounted in
 *   the mobile top bar and the desktop rail's foot, with a "View all
 *   notifications" link back to the page.
 *
 * WHY DEMO ACCESS IS A SUB-ITEM AND NOT A SIXTH DESTINATION
 *   /settings/access shipped with NOTHING linking to it — a repo-wide search
 *   for the path found only the page itself. A feature the owner cannot
 *   navigate to does not exist, and this one hands out a working credential and
 *   is the only place its audit trail can be read, so "reachable" is not a
 *   nicety. It is not promoted to the rail: issuing a 72-hour demo code is an
 *   occasional owner task, not one of the five things a job search is made of.
 *   As a sub-item it takes the same shape as Companies and Contacts, and
 *   because /settings/access is literally a child of /settings the sidebar's
 *   exact-or-descendant test already lights the Settings section and puts
 *   aria-current on the sub-item — no special case anywhere.
 *
 *   Note it is visible to a DEMO visitor too (this list is static and has no
 *   session): that is by design and costs nothing. The page itself says demo
 *   workspaces cannot issue codes, POST /api/access-codes refuses them with a
 *   403, and a trigger in 20260803000003 refuses the insert at the database.
 *   The entry leads to an explanation, not to a capability.
 */
export const navItems: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Today',
    icon: LayoutDashboard,
  },
  {
    href: '/jobs',
    label: 'Opportunities',
    icon: Briefcase,
    subItems: [
      { href: '/companies', label: 'Companies', icon: Building2 },
    ],
  },
  {
    href: '/pipeline',
    label: 'Applications',
    icon: KanbanSquare,
    subItems: [
      { href: '/queue', label: 'Needs you', icon: Inbox },
      { href: '/prep', label: 'Interview prep', icon: GraduationCap },
      { href: '/contacts', label: 'Contacts', icon: Users },
      { href: '/insights', label: 'Insights', icon: BarChart3 },
    ],
  },
  {
    href: '/resume',
    label: 'Resume',
    icon: FileText,
  },
  {
    href: '/copilot',
    label: 'Copilot',
    icon: Sparkles,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    subItems: [
      { href: '/settings/access', label: 'Demo access', icon: KeyRound },
    ],
  },
]
