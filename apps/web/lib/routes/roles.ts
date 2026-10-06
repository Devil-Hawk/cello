import type { PageRoute } from './types'

export const route: PageRoute = { label: 'Roles', href: '/jobs', shipped: false, bar: true }

/** The record of one role. Every role title in the app links here. */
export function recordHref(id: string): string {
  return `/jobs?job=${encodeURIComponent(id)}`
}
