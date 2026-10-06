// The facts and the words of Welcome, as pure functions. Counts and lines come
// from code (directive 20); nothing here asks a model.

import { resolveRoleIntent } from '@/lib/jobs/role-taxonomy'
import { applications, chat, companies, network, roles, today, type PageRoute } from '@/lib/routes'

export const SCREENS = ['resume', 'want', 'connect', 'roles'] as const
export type Screen = (typeof SCREENS)[number]

export const SCREEN_TITLES: Record<Screen, string> = {
  resume: 'Your resume',
  want: 'What you want',
  connect: 'Connect',
  roles: 'Your roles',
}

export function progress(screen: Screen): { index: number; total: number } {
  return { index: SCREENS.indexOf(screen) + 1, total: SCREENS.length }
}

export function nextScreen(screen: Screen): Screen {
  return SCREENS[Math.min(SCREENS.indexOf(screen) + 1, SCREENS.length - 1)]
}

export function previousScreen(screen: Screen): Screen {
  return SCREENS[Math.max(SCREENS.indexOf(screen) - 1, 0)]
}

// --- the resume -------------------------------------------------------------

export const THIN_WORDS = 150
export const THIN_LINE = 'That is thin. Chances are checked against these lines.'
export const READ_FAILED = 'Could not read that file. Paste the text instead.'

export interface ResumeRead {
  words: number
  heading: string | null
  thin: boolean
}

export function readResume(text: string): ResumeRead {
  const words = text.split(/\s+/).filter(Boolean).length
  const heading = text.match(/^#{1,3}\s+(.+?)\s*$/m)?.[1] ?? null
  return { words, heading, thin: words < THIN_WORDS }
}

/** "Read 312 words. First heading: Senior Software Engineer." */
export function readLine(r: ResumeRead): string {
  const base = `Read ${r.words} ${r.words === 1 ? 'word' : 'words'}.`
  return r.heading ? `${base} First heading: ${r.heading}.` : base
}

/** The name at the top of a resume: a short first line with no digits or addresses. */
export function nameFromResume(text: string): string {
  const first = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  if (!first || first.length > 60 || /[\d@:/]/.test(first)) return ''
  return first.split(/\s+/).length <= 5 ? first : ''
}

// --- what you want ----------------------------------------------------------

export function fitLine(count: number | null): string | null {
  if (count === null) return null
  if (count === 0) return NO_FITS
  return `${count} open ${count === 1 ? 'role fits' : 'roles fit'} this right now.`
}

export const NO_FITS = 'No open roles fit this yet.'
export const LISTED_LINE = 'Listed by title and date. Not ranked for you yet.'
export const FOLLOW_LINE = 'Follow an employer on Companies to hear from it faster.'

/** "Deployment Strategist is a Forward Deployed Engineer role." from a typed title, or null when code cannot place it. */
export function typedTitle(title: string): { id: string; label: string; line: string } | null {
  const t = title.trim()
  if (!t) return null
  const intent = resolveRoleIntent(t)
  return intent ? { id: intent.id, label: intent.label, line: `${t} is a ${intent.label} role.` } : null
}

// --- the guided demo --------------------------------------------------------

export const DEMO_LINE = '72 hours, $1.00 of AI budget, made-up companies'
export const TOUR_DISMISSED_KEY = 'cello.tour.dismissed'

export interface TourStop {
  id: string
  label: string
  says: string
  route: PageRoute
}

// In the owner's order. A stop appears only once its page has shipped.
const ALL_STOPS: TourStop[] = [
  { id: 'chat', label: 'Chat', says: 'Ask for roles in your own words. A suggestion is ready.', route: chat },
  { id: 'record', label: 'A role', says: 'Open one role to see its pluses and minuses.', route: roles },
  { id: 'companies', label: 'Companies', says: 'Every employer Cello knows, and the ones you follow.', route: companies },
  { id: 'network', label: 'Network', says: 'One follow-up is due.', route: network },
  { id: 'today', label: 'Today', says: 'What needs you, first.', route: today },
  { id: 'applications', label: 'Applications', says: 'Where each one stands, and what is working.', route: applications },
]

export function tourStops(): TourStop[] {
  return ALL_STOPS.filter((s) => s.route.shipped)
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

function safeStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Dismissed for good once set. Storage that cannot be read counts as dismissed, so a blocked store never nags. */
export function tourDismissed(store: Store | null = safeStore()): boolean {
  if (!store) return true
  try {
    return store.getItem(TOUR_DISMISSED_KEY) === '1'
  } catch {
    return true
  }
}

export function dismissTour(store: Store | null = safeStore()): void {
  try {
    store?.setItem(TOUR_DISMISSED_KEY, '1')
  } catch {
    /* a blocked store only means it may show again */
  }
}
