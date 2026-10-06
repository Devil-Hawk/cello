'use client'

// Titles you count as yours: the person's typed titles and corrections, each with the role type it counts as
// and Remove. "Cello counts Deployment Strategist as Forward Deployed Engineer for you."

import { useCallback, useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'

interface Title {
  title: string
  roleType: string
  label: string
  source: 'correction' | 'typed'
}

export function TitlesYours() {
  const [titles, setTitles] = useState<Title[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/titles')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error)
      setTitles(body.titles as Title[])
    } catch {
      setError('Could not read your titles.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(t: Title) {
    setError(null)
    const res = await fetch('/api/settings/titles', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title_norm: t.title }) })
    if (res.ok) setTitles((prev) => (prev ?? []).filter((x) => x.title !== t.title))
    else setError('Could not remove that.')
  }

  if (titles !== null && titles.length === 0 && !error) return null
  return (
    <div>
      <h3 className="r-title">Titles you count as yours</h3>
      {titles === null && !error && <p className="r-meta">Reading.</p>}
      <ul>
        {(titles ?? []).map((t) => (
          <li key={t.title} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
            <p className="r-body min-w-0 flex-1 basis-56">Cello counts {t.title} as {t.label} for you.</p>
            <Key variant="ghost" aria-label={`Remove ${t.title}`} onClick={() => remove(t)}>Remove</Key>
          </li>
        ))}
      </ul>
      {error && <p className="r-meta" role="alert">{error}</p>}
    </div>
  )
}
