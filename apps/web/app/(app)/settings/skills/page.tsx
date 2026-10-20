import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Skills } from '@/components/settings/skills'

export const metadata = { title: 'Your skills' }

/** Settings › Your skills: Cello's own skills and the ones the person adds. */
export default function SkillsPage() {
  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6">
      <div>
        <Link href="/settings" className="inline-flex min-h-11 items-center gap-1 rounded-control text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Settings
        </Link>
        <h1 className="mt-1 font-display text-title text-foreground">Your skills</h1>
      </div>
      <Skills />
    </div>
  )
}
