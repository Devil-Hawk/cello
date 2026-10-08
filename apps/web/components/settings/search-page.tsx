'use client'

// Your search (blueprint 4.11), in its order: what Cello does alone, what you want with its live line, what Cello
// learned, what it does on its own and those settings, your own instructions, your browser. The targeting chooser
// moved here from Settings.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { Key } from '@/components/ui/key'
import { TargetingTab } from '@/components/settings/targeting-tab'
import { TitlesYours } from '@/components/settings/titles-yours'
import { Learned } from '@/components/settings/learned'
import { OnItsOwn } from '@/components/settings/on-its-own'
import { OnItsOwnSettings } from '@/components/settings/on-its-own-settings'
import { OutreachPrefsCard } from '@/components/settings/outreach-prefs-card'
import { Instructions } from '@/components/settings/instructions'
import { YourBrowser } from '@/components/settings/your-browser'
import { EMPTY_TARGETING, type Targeting } from '@/lib/targeting'

/**
 * "12 of today's 41 new roles fit this." Both numbers are counted in SQL by the read: the roles kept for this
 * person today (person_roles) and those the read left outside their targets today (person_counts). Pure.
 */
export function liveLine(fit: number, outside: number): string {
  const total = fit + outside
  if (total === 0) return "Cello has not read any new roles today."
  return `${fit} of today's ${total} new ${total === 1 ? 'role fits' : 'roles fit'} this.`
}

export function SearchPage() {
  const [targeting, setTargeting] = useState<Targeting | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [paused, setPaused] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [followed, setFollowed] = useState<number | null>(null)
  const [live, setLive] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/targeting')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { targeting?: Targeting }) => setTargeting(d.targeting ?? EMPTY_TARGETING))
      .catch(() => setLoadError(true))
    // person_roles and person_counts are newer than the generated types
    const db = createClient() as unknown as SupabaseClient
    db.from('companies').select('id', { count: 'exact', head: true }).eq('watching', true).then(({ count }) => setFollowed(count ?? 0))
    const day = new Date().toISOString().slice(0, 10)
    Promise.all([
      db.from('person_roles').select('job_id', { count: 'exact', head: true }).is('hidden_reason', null).gte('visible_since', `${day}T00:00:00Z`),
      db.from('person_counts').select('n').eq('kind', 'outside_targets').eq('day', day),
    ])
      .then(([fit, out]) => setLive(liveLine(fit.count ?? 0, ((out.data ?? []) as { n: number }[]).reduce((sum, r) => sum + Number(r.n), 0))))
      .catch(() => undefined)
  }, [])

  async function pause() {
    setStatus(null)
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
        {paused ? 'Cello is paused. Nothing is prepared or sent until you resume. ' : 'Cello prepares. You send. '}
        <details className="inline">
          <summary className="inline cursor-pointer underline">Learn more</summary>
          <span className="block">Cello prepares roles you Apply to and waits for you to send them. It sends nothing to anyone but you on its own.</span>
        </details>
      </div>
      {status && <p className="r-meta" role="alert">{status}</p>}

      <section aria-labelledby="want-heading" className="r-sheet space-y-6 p-6">
        <div>
          <h2 id="want-heading" className="r-title">What you want</h2>
          {live && <p className="r-body mt-1">{live}</p>}
        </div>
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
      <section aria-labelledby="own-settings-heading" className="r-sheet space-y-6 p-6">
        <h2 id="own-settings-heading" className="r-title">When and how much</h2>
        <OnItsOwnSettings onLoaded={(v) => setPaused(v.settings.pausedAt !== null)} />
        <OutreachPrefsCard onStatus={(s, m) => setStatus(s === 'error' ? m : 'Saved.')} />
      </section>
      <Instructions />
      <section aria-labelledby="browser-heading" className="r-sheet space-y-4 p-6">
        <h2 id="browser-heading" className="r-title">Your browser</h2>
        <YourBrowser />
      </section>
    </div>
  )
}
