import type { PageRoute } from './types'

export const route: PageRoute = { label: 'Companies', href: '/companies', shipped: true, bar: true }

/** One employer's page. Every logo and company name links here. */
export function companyHref(id: string): string {
  return `/companies/${encodeURIComponent(id)}`
}
