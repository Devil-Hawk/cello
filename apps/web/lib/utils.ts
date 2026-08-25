import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge, taught about this project's custom font-size scale.
 *
 * WHY THIS IS NOT THE DEFAULT twMerge: our fontSize keys (display, title,
 * section, body, caption, label, stat, readout, readout-lg) are not in
 * tailwind-merge's built-in table, so it filed them under the same class group
 * as text COLOURS. That made `cn('text-primary-foreground', 'text-caption')`
 * collapse to just `text-caption` — silently dropping the colour. Every
 * <Button size="sm"> on a coloured variant lost its foreground and rendered
 * unreadable text on an accent background.
 *
 * Registering them as font-size classes keeps size and colour in separate
 * groups, so both survive the merge.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'title',
            'section',
            'body',
            'caption',
            'label',
            'stat',
            'readout',
            'readout-lg',
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(date: Date | string): string {
  const now = new Date()
  const then = new Date(date)
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`

  return then.toLocaleDateString()
}

export function getCompanyLogoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

/**
 * A client-local id for React keys and optimistic rows.
 *
 * NOT crypto.randomUUID(). That function is SECURE-CONTEXT ONLY: over plain
 * http:// to any host other than localhost/127.0.0.1 it is `undefined`, so
 * calling it throws. Inside an async handler the rejection does not surface
 * synchronously, so the caller's optimistic work (clearing the composer, say)
 * has already happened and the user sees their input vanish with no error and
 * no request. The copilot page was the only client file using it, which is why
 * that surface alone broke on a LAN origin while every other page worked.
 *
 * These ids never leave the browser and are not security material — they key
 * React lists and correlate an optimistic message with its server row — so a
 * non-cryptographic fallback is correct rather than a compromise. The random
 * suffix plus a timestamp is far beyond what uniqueness within one open tab
 * requires.
 */
export function newClientId(prefix = 'c'): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID()
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
