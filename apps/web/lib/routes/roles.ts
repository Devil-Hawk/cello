import type { PageRoute } from './types'

export const route: PageRoute = { label: 'Roles', href: '/roles', shipped: true, bar: true }

/** The record of one role. Every role title in the app links here. */
export function recordHref(id: string): string {
  return `/roles/${encodeURIComponent(id)}`
}
