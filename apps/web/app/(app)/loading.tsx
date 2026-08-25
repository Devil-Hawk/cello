import { LogoMark } from '@/components/brand/logo'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-transition fallback for every page under the authenticated shell.
 * Next.js swaps this in the instant a nav link is clicked, for as long as
 * the destination route's payload is in flight — before this file existed
 * there was no loading.tsx anywhere in the app, so clicking a sidebar link
 * produced zero feedback (not even the item highlighting) for however long
 * a heavy route took to load. Deliberately generic: unlike each page's own
 * <Page>Skeleton (dashboard/page.tsx, jobs/page.tsx, ...) this can't know
 * the destination's real shape, so it only has to read as "the next page is
 * coming," never as content that could be mistaken for a real page.
 */
export default function AppLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LogoMark className="h-7 w-7" loading />
        <span className="text-caption text-muted-foreground">Loading…</span>
        {/* The visible caption above says nothing to a screen reader on its
            own — route changes had zero aria-live/role="status" anywhere in
            the shell, so this transition was total silence for anyone not
            looking at the screen. */}
        <span role="status" aria-live="polite" className="sr-only">
          Loading page
        </span>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 rounded-card border bg-card p-5 shadow-card lg:col-span-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="space-y-3 rounded-card border bg-card p-5 shadow-card">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  )
}
