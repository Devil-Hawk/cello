import Link from 'next/link'
import { Compass } from 'lucide-react'
import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

export const metadata = {
  title: 'Page not found — Cello',
}

/**
 * Root not-found — catches any URL that matches no route at all, signed in
 * or not, so unlike app/(app)/error.tsx it can't assume the authenticated
 * shell (Sidebar/Header) is standing around it. Same EmptyState language as
 * every other "X not found" moment in the app (see companies/[id]/page.tsx,
 * prep/[id]/page.tsx), plus its own wordmark for wayfinding since there's no
 * sidebar here to supply one.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <Logo />
      <EmptyState
        icon={Compass}
        headingLevel="h1"
        title="Page not found"
        body="There's nothing at this address. It may have been moved, or the link is wrong."
        className="max-w-md"
        action={
          <Button asChild>
            <Link href="/dashboard">Back to Today</Link>
          </Button>
        }
      />
    </div>
  )
}
