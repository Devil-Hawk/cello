'use client'

// Your data (blueprint 4.12): export what Cello holds, and delete the account. Deleting asks for the sentence to
// be typed, names what goes, and signs the person out when it is done.

import { useState } from 'react'
import { Key } from '@/components/ui/key'

export const DELETE_SENTENCE = 'delete my account'

export function DataSection() {
  const [asking, setAsking] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: DELETE_SENTENCE }) })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Could not delete the account. Nothing changed.')
      window.location.assign('/login')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the account. Nothing changed.')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="r-body">Your applications, people, the headers of your mail with them, drafts, reactions and what Cello made, as one file.</p>
        <Key asChild variant="raised"><a href="/api/settings/export" download>Export my data</a></Key>
      </div>
      <div className="space-y-2">
        <h3 className="r-name">Delete account</h3>
        <p className="r-body">This removes your resume, applications, people, drafts, what Cello learned and your sign-in. It cannot be undone. Mail in your Gmail is not touched.</p>
        {!asking ? (
          <Key variant="raised" onClick={() => setAsking(true)}>Delete my account</Key>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <span className="r-meta block">Type {DELETE_SENTENCE} to confirm</span>
              <input className="r-field min-h-11 w-full max-w-sm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Key disabled={busy || typed.trim().toLowerCase() !== DELETE_SENTENCE} onClick={remove}>{busy ? 'Deleting' : 'Delete everything'}</Key>
              <Key variant="ghost" onClick={() => { setAsking(false); setTyped('') }}>Keep my account</Key>
            </div>
          </div>
        )}
        {error && <p className="r-meta" role="alert">{error}</p>}
      </div>
    </div>
  )
}
