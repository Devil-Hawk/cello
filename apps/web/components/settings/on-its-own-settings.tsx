'use client'

// What Cello does on its own, and when (blueprint 4.11): the pick time, a weekly pace, whether Strong picks are
// prepared each morning and how many, follow-up drafts, the daily summary, whether each resume is shown first, and
// quiet hours. They govern sending and email, never finding. Saved through /api/settings/pipeline, which writes with
// autonomy.update. The outreach daily limit sits beside them (OutreachPrefsCard).

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { MODE_LABELS, type Mode } from '@/lib/chat/mode'
import type { PipelineSettings } from '@/lib/pipeline/settings'
import { cn } from '@/lib/utils'

export interface PipelineView {
  settings: PipelineSettings
  weeklyPace: number | null
  /** The older in-app digest opt-in (preferences.digest.enabled); it follows the summary switch. */
  digest: boolean
}

export interface Form {
  pickAt: string
  weeklyPace: string
  prepareStrong: boolean
  perDay: string
  followUps: boolean
  summary: boolean
  resumeApproval: boolean
  quietFrom: string
  quietTo: string
  /** How Chat works. Hands-off can be chosen only while Send for me is on. */
  mode: Mode
  /** Read only here: Send for me is turned on under Your browser. */
  sendOn: boolean
}

/** The sentence under Hands-off, and the reason it is greyed while Send for me is off. */
export const HANDS_OFF_SENTENCE = 'Cello prepares what you ask for and lets Send for me send it from your browser, within Send for me\'s limits.'
export const SEND_OFF_SENTENCE = 'Turn Send for me on first, under Your browser.'

export const toForm = (v: PipelineView): Form => ({
  pickAt: v.settings.morning.pickAt,
  weeklyPace: v.weeklyPace === null ? '' : String(v.weeklyPace),
  prepareStrong: v.settings.want.mode === 'rule',
  perDay: String(v.settings.want.maxPerDay),
  followUps: v.settings.followUps.on,
  summary: v.settings.summary || v.digest,
  resumeApproval: v.settings.resumeApproval,
  quietFrom: v.settings.morning.quietFrom,
  quietTo: v.settings.morning.quietTo,
  mode: v.settings.mode,
  sendOn: v.settings.send.mode === 'auto',
})

/** Only what changed, in the shape the route takes. Pure. */
export function diff(a: Form, b: Form): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (a.pickAt !== b.pickAt) patch.pickAt = b.pickAt
  if (a.weeklyPace !== b.weeklyPace) patch.weeklyPace = b.weeklyPace.trim() === '' ? null : Number(b.weeklyPace)
  if (a.prepareStrong !== b.prepareStrong) patch.prepareStrong = b.prepareStrong
  if (a.perDay !== b.perDay) patch.perDay = Number(b.perDay)
  if (a.followUps !== b.followUps) patch.followUps = b.followUps
  if (a.summary !== b.summary) patch.summary = b.summary
  if (a.resumeApproval !== b.resumeApproval) patch.resumeApproval = b.resumeApproval
  if (a.quietFrom !== b.quietFrom) patch.quietFrom = b.quietFrom
  if (a.quietTo !== b.quietTo) patch.quietTo = b.quietTo
  if (a.mode !== b.mode) patch.mode = b.mode
  return patch
}

const MODES: Mode[] = ['ask', 'hands_off']

/** How Chat works: two choices, Hands-off greyed with the reason while Send for me is off. */
export function ModeChoice({ mode, sendOn, onChange }: { mode: Mode; sendOn: boolean; onChange: (m: Mode) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="r-meta mb-1">How Chat works</legend>
      {MODES.map((m) => {
        const off = m === 'hands_off' && !sendOn
        return (
          <label key={m} className={cn('flex min-h-11 items-start gap-3 py-1', off && 'opacity-60')}>
            <input type="radio" name="chat-mode" className="mt-1 h-4 w-4" value={m} checked={mode === m} disabled={off} onChange={() => onChange(m)} />
            <span>
              <span className="r-body block">{MODE_LABELS[m]}</span>
              <span className="r-meta block">{m === 'ask' ? 'Cello finds, researches, drafts and tailors on its own. Applying waits for you.' : `${HANDS_OFF_SENTENCE}${off ? ` ${SEND_OFF_SENTENCE}` : ''}`}</span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

export function OnItsOwnForm({ form, onChange, onSave, saving, note }: { form: Form; onChange: (f: Form) => void; onSave: () => void; saving?: boolean; note?: string | null }) {
  const set = <K extends keyof Form>(k: K, v: Form[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="r-meta block">Pick today&apos;s roles at</span>
          <input type="time" min="05:00" max="10:00" className="r-field min-h-11 w-full" value={form.pickAt} onChange={(e) => set('pickAt', e.target.value)} />
        </label>
        <label className="block">
          <span className="r-meta block">Applications a week you are aiming for</span>
          <input type="number" inputMode="numeric" min={1} max={100} placeholder="No pace set" className="r-field min-h-11 w-full" value={form.weeklyPace} onChange={(e) => set('weeklyPace', e.target.value)} />
        </label>
        <label className="block">
          <span className="r-meta block">Quiet hours from</span>
          <input type="time" className="r-field min-h-11 w-full" value={form.quietFrom} onChange={(e) => set('quietFrom', e.target.value)} />
        </label>
        <label className="block">
          <span className="r-meta block">Quiet hours until</span>
          <input type="time" className="r-field min-h-11 w-full" value={form.quietTo} onChange={(e) => set('quietTo', e.target.value)} />
        </label>
      </div>
      <p className="r-meta">Quiet hours hold messages and email to you. They never stop Cello from finding roles.</p>

      <div className="space-y-1">
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={form.prepareStrong} onChange={(e) => set('prepareStrong', e.target.checked)} />
          <span className="r-body">Prepare my Strong picks each morning</span>
        </label>
        <label className="ml-7 block">
          <span className="r-meta block">At most this many a day, 1 to 10</span>
          <input type="number" inputMode="numeric" min={1} max={10} className="r-field min-h-11 w-28" value={form.perDay} disabled={!form.prepareStrong} onChange={(e) => set('perDay', e.target.value)} />
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={form.resumeApproval} onChange={(e) => set('resumeApproval', e.target.checked)} />
          <span className="r-body">Show me each resume first</span>
        </label>
        <ModeChoice mode={form.mode} sendOn={form.sendOn} onChange={(m) => set('mode', m)} />
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={form.followUps} onChange={(e) => set('followUps', e.target.checked)} />
          <span className="r-body">Draft follow-ups when someone has gone quiet</span>
        </label>
        <p className="r-meta ml-7">When one is due is set in <Link href="/network" className="underline">Network</Link>, for everyone or for one person.</p>
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={form.summary} onChange={(e) => set('summary', e.target.checked)} />
          <span className="r-body">Send me a daily summary</span>
        </label>
        <p className="r-meta ml-7">It goes to your own inbox, and only when you have allowed Cello to send from your Gmail.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Key disabled={saving} onClick={onSave}>{saving ? 'Saving' : 'Save'}</Key>
        {note && <p className="r-meta" role="status">{note}</p>}
      </div>
    </div>
  )
}

export function OnItsOwnSettings({ onLoaded }: { onLoaded?: (v: PipelineView) => void }) {
  const [saved, setSaved] = useState<Form | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // a new callback each render must not refetch
  const loaded = useRef(onLoaded)
  loaded.current = onLoaded
  const apply = useCallback((v: PipelineView) => {
    const f = toForm(v)
    setSaved(f)
    setForm(f)
    loaded.current?.(v)
  }, [])

  useEffect(() => {
    fetch('/api/settings/pipeline')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((v: PipelineView) => apply(v))
      .catch(() => setFailed(true))
  }, [apply])

  async function save() {
    if (!form || !saved) return
    const patch = diff(saved, form)
    if (Object.keys(patch).length === 0) return setNote('Nothing changed.')
    setSaving(true)
    setNote(null)
    try {
      const res = await fetch('/api/settings/pipeline', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      const body = (await res.json().catch(() => ({}))) as PipelineView & { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Could not save. Nothing changed.')
      // the older in-app digest follows the summary switch, so turning it off here turns it off there too
      if ('summary' in patch) await fetch('/api/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: patch.summary }) }).catch(() => undefined)
      apply({ ...body, digest: form.summary })
      setNote('Saved.')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save. Nothing changed.')
    } finally {
      setSaving(false)
    }
  }

  if (failed) return <p className="r-body" role="alert">Could not read these settings. Reload to try again.</p>
  if (!form) return <p className="r-meta">Reading.</p>
  return <OnItsOwnForm form={form} onChange={setForm} onSave={save} saving={saving} note={note} />
}
