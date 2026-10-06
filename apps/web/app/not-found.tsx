import Link from 'next/link'
import { MarkTwin } from '@/components/depth/twins'
import { Key } from '@/components/ui/key'
import { today } from '@/lib/routes'

export const metadata = {
  title: 'Page not found',
}

/**
 * Root not-found. It catches any address that matches no route, signed in or
 * not, so it cannot lean on the signed-in shell. It names the problem, says
 * what to do next, and links to Today.
 */
export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-r-ground px-4 py-12 text-center font-r text-r-ink"
    >
      <MarkTwin size={48} />
      <div className="max-w-md space-y-2">
        <h1 className="r-section">That page is not here</h1>
        <p className="r-body text-r-ink-2">The link may be old, or the address may have a typo.</p>
      </div>
      <Key asChild>
        <Link href={today.href}>Go to Today</Link>
      </Key>
    </main>
  )
}
