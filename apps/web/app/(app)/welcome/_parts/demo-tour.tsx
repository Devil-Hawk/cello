'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import { REFUSALS } from '@/components/brand/landing/content'
import { createClient } from '@/lib/supabase/client'
import { today } from '@/lib/routes'
import { recordHref } from '@/lib/routes/roles'
import { DEMO_LINE, dismissTour, tourDismissed, tourStops, type TourStop } from './logic'

// A demo is one screen: what Cello will not do and what this workspace is, then
// a short tour of the pages that have shipped, on made-up data. The tour is
// dismissible and never returns once dismissed. A demo is never asked for a key.
export function DemoScreen({ onFinish, finishing }: { onFinish: () => void; finishing: boolean }) {
  const [stops, setStops] = useState<TourStop[]>([])
  const [firstRole, setFirstRole] = useState<string | null>(null)

  useEffect(() => {
    // Read after mount: storage does not exist on the server.
    setStops(tourDismissed() ? [] : tourStops())
  }, [])

  // The role stop opens a real record: the newest role the demo holds. Until it is known, the stop opens Roles.
  useEffect(() => {
    void createClient()
      .from('person_roles')
      .select('job_id')
      .is('hidden_reason', null)
      .order('visible_since', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setFirstRole((data as { job_id?: string } | null)?.job_id ?? null))
  }, [])

  return (
    <div className="space-y-8">
      <div>
        <h2 className="r-section">This is a demo</h2>
        <p className="r-body mt-2 text-r-ink-2">{DEMO_LINE}</p>
      </div>

      <ul className="space-y-3">
        {REFUSALS.map((r) => (
          <li key={r.heading} className="r-body">
            {r.sentence}
          </li>
        ))}
      </ul>

      {stops.length > 0 && (
        <section aria-labelledby="tour" className="r-sheet space-y-3">
          <h3 id="tour" className="r-title">
            A short tour
          </h3>
          <ol className="space-y-2">
            {stops.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link href={s.id === 'record' && firstRole ? recordHref(firstRole) : s.route.href} className="r-name underline underline-offset-4">
                  {s.label}
                </Link>
                <span className="r-body text-r-ink-2">{s.says}</span>
              </li>
            ))}
          </ol>
          <Key
            variant="ghost"
            onClick={() => {
              dismissTour()
              setStops([])
            }}
          >
            Skip the tour
          </Key>
        </section>
      )}

      <Key onClick={onFinish} disabled={finishing}>
        {finishing ? 'Opening' : `Go to ${today.label}`}
      </Key>
    </div>
  )
}
