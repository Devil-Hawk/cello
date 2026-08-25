import {
  LayoutDashboard,
  Building2,
  Briefcase,
  KanbanSquare,
  Users,
  Bell,
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
   *  there are none (Copilot, Settings). */
  subItems?: NavSubItem[]
}

/**
 * Single source of truth for primary app navigation (sidebar + any future
 * mobile nav): five destinations organised around the user's day rather
 * than the underlying subsystems —
 *
 *   Today         /dashboard   + Notifications (the global inbox)
 *   Opportunities /jobs        + Companies (watchlist / research context)
 *   Applications  /pipeline    + Needs you (queue), Interview prep,
 *                                Contacts, Insights (funnel + source stats)
 *   Copilot       /copilot
 *   Settings      /settings
 *
 * Old subsystem-organised sections (Companies, Contacts, Prep, Queue,
 * Insights, Notifications) are not gone — they're the `subItems` above,
 * still real routes, just reached as a sub-view of the destination they
 * belong to now instead of sitting in the primary rail themselves.
 */
export const navItems: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Today',
    icon: LayoutDashboard,
    subItems: [
      { href: '/notifications', label: 'Notifications', icon: Bell },
    ],
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
    href: '/copilot',
    label: 'Copilot',
    icon: Sparkles,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
  },
]
