'use client'

// "You might follow": up to five employers Cello suggests, each with its reason. Following one goes through
// the suggestion's own route, which checks whose board it is before anything is followed.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile } from '@/components/roles/role-tile'
import type { Suggestion } from '@/lib/companies/types'
import { failLine, followedLine } from './logic'

export function Suggestions({ items }: { items: Suggestion[] }) {
  const router = useRouter()
  const [gone, setGone] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function act(s: Suggestion, action: 'add' | 'dismiss') {
    setBusy(s.id)
    try {
      const res = await fetch(`/api/companies/suggestions/${s.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      const body = (await res.json().catch(() => null)) as { status?: string; notAdded?: { reason: Parameters<typeof failLine>[0] } } | null
      if (body?.notAdded) setGone((g) => ({ ...g, [s.id]: failLine(body.notAdded!.reason, { name: s.name, domain: s.domain }) }))
      else if (res.ok) {
        setGone((g) => ({ ...g, [s.id]: action === 'add' ? followedLine(s.name) : '' }))
        if (action === 'add') router.refresh()
      } else setGone((g) => ({ ...g, [s.id]: failLine('network', {}) }))
    } catch {
      setGone((g) => ({ ...g, [s.id]: failLine('network', {}) }))
    } finally {
      setBusy(null)
    }
  }

  const open = items.filter((s) => gone[s.id] === undefined || gone[s.id] !== '')
  if (open.length === 0) return null
  return (
    <section aria-labelledby="might" className="space-y-2">
      <h2 id="might" className="r-title px-2">
        You might follow
      </h2>
      <div className="r-sheet">
        {open.map((s) => (
          <div key={s.id} className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 px-2 py-3">
            <LogoTile name={s.name} domain={s.domain} logoUrl={s.logoUrl} size={40} />
            <div className="min-w-0 flex-1 basis-48">
              <span className="r-name">{s.name}</span>
              <p className="r-meta">{s.reason}</p>
              {gone[s.id] && (
                <p role="status" className="r-meta">
                  {gone[s.id]}
                </p>
              )}
            </div>
            {gone[s.id] === undefined && (
              <div className="flex flex-none gap-2">
                <Key variant="raised" disabled={busy === s.id} aria-label={`Follow ${s.name}`} onClick={() => act(s, 'add')}>
                  Follow
                </Key>
                <Key variant="ghost" disabled={busy === s.id} aria-label={`Not ${s.name}`} onClick={() => act(s, 'dismiss')}>
                  Not now
                </Key>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
