'use client'

// Your search (blueprint 4.11), in its order: what Cello does alone, what you want, what Cello learned, what it
// does on its own and its settings, your own instructions. The targeting chooser moved here from Settings.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Key } from '@/components/ui/key'
import { TargetingTab } from '@/components/settings/targeting-tab'
import { TitlesYours } from '@/components/settings/titles-yours'
import { Learned } from '@/components/settings/learned'
import { OnItsOwn } from '@/components/settings/on-its-own'
import { OutreachPrefsCard } from '@/components/settings/outreach-prefs-card'
import { Instructions } from '@/components/settings/instructions'
import { EMPTY_TARGETING, type Targeting } from '@/lib/targeting'

export function SearchPage() {
  const [targeting, setTargeting] = useState<Targeting | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [paused, setPaused] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [followed, setFollowed] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/settings/targeting')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { targeting?: Targeting }) => setTargeting(d.targeting ?? EMPTY_TARGETING))
      .catch(() => setLoadError(true))
    createClient()
      .from('companies')
      .select('id', { count: 'exact', head: true })
      .eq('watching', true)
      .then(({ count }) => setFollowed(count ?? 0))
  }, [])

  async function pause() {
    setStatus(null)
    // ponytail: the page does not read the paused state back; it shows what the last press did.
    const res = await fetch('/api/pipeline/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(paused ? { resume: true } : {}) })
    if (res.ok) setPaused(!paused)
    else setStatus('Could not do that. Nothing changed.')
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-10 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="r-display">Your search</h1>
        <Key variant={paused ? 'ink' : 'raised'} onClick={pause}>{paused ? 'Resume Cello' : 'Pause Cello'}</Key>
      </header>
      <div className="r-body -mt-6">
        Cello prepares. You send.{' '}
        <details className="inline">
          <summary className="inline cursor-pointer underline">Learn more</summary>
          <span className="block">Cello prepares roles you Apply to and waits for you to send them. It sends nothing to anyone but you on its own.</span>
        </details>
      </div>
      {status && <p className="r-meta" role="alert">{status}</p>}

      <section aria-labelledby="want-heading" className="r-sheet space-y-6 p-6">
        <h2 id="want-heading" className="r-title">What you want</h2>
        {loadError ? (
          <p className="r-body" role="alert">Could not read what you want. Reload to try again.</p>
        ) : targeting === null ? (
          <p className="r-meta">Reading.</p>
        ) : (
          <TargetingTab initialTargeting={targeting} onStatus={(s, m) => setStatus(s === 'error' ? m : null)} />
        )}
        <TitlesYours />
        <p className="r-body">
          {followed === null ? '' : followed === 0 ? "You don't follow any companies. Cello still finds roles across the market." : `You follow ${followed} ${followed === 1 ? 'company' : 'companies'}.`}{' '}
          <Link href="/companies" className="underline">Open Companies</Link>
        </p>
      </section>

      <Learned />
      <OnItsOwn />
      <OutreachPrefsCard onStatus={(s, m) => setStatus(s === 'error' ? m : 'Saved.')} />
      <Instructions />
    </div>
  )
}
