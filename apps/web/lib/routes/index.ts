import type { PageRoute } from './types'
import { route as today } from './today'
import { route as roles } from './roles'
import { route as companies } from './companies'
import { route as network } from './network'
import { route as applications } from './applications'
import { route as conversations } from './conversations'
import { route as chat } from './chat'
import { route as profile } from './profile'
import { route as search } from './search'
import { route as settings } from './settings'
import { route as welcome } from './welcome'
import { route as landing } from './landing'
import { route as login } from './login'

export type { PageRoute } from './types'
export { older } from './older'
export { today, roles, companies, network, applications, conversations, chat, profile, search, settings, welcome, landing, login }

/** The page keys in the bar, in order. Chat stands apart: it is its own key, only when it ships. */
export const barRoutes: PageRoute[] = [today, roles, companies, network, applications, conversations].filter(
  (r) => r.bar,
)

/** The phone's tabs: four pages, then Chat once it is in the bar, else Conversations. */
export const phoneTabs: PageRoute[] = [today, roles, companies, applications, chat.bar ? chat : conversations]

/** Chat is its own key and tab only for a person it is open for; the others keep the old Chat page in their menu. */
const oldChat: PageRoute = { label: 'Chat', href: '/copilot', shipped: false, bar: false }

/** The account menu: every page that is not a key in the bar, once per address. */
export function accountRoutes(chatOpen = false): PageRoute[] {
  const seen = new Set<string>()
  // Settings before Your search: while both point at /settings, Settings is the one that shows.
  return [profile, network, ...(chatOpen ? [] : [oldChat]), settings, search].filter((r) => {
    if (r.bar || seen.has(r.href)) return false
    seen.add(r.href)
    return true
  })
}

/** Is this address the page itself or inside it. */
export function isCurrent(pathname: string, href: string): boolean {
  const path = href.split('?')[0]
  return pathname === path || pathname.startsWith(`${path}/`)
}
