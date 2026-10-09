import { notFound } from 'next/navigation'
import { fixturesOn } from '@/lib/depth/fixtures-flag'

// Read per request: the flag is an environment value, not a build-time fact.
export const dynamic = 'force-dynamic'

export default function FixturesLayout({ children }: { children: React.ReactNode }) {
  if (!fixturesOn()) notFound()
  return <div className="min-h-screen bg-r-ground font-r text-r-ink">{children}</div>
}
