'use client'

// The record after acting, group one: the application (blueprint 4.6). The status sentence and its one button, a
// stage suggestion with Confirm, the interview date, the person's instruction for this application, their notes (never
// read as instructions) and the timeline with what Cello did. Nothing here sends anything.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { statusSentence } from '@/lib/pipeline/states'
import { actorWords, type Door } from '@/lib/pipeline/actors'
import { CLOSED_LABEL } from '@/components/pipeline/applications-view'
import { ago } from '@/lib/network/format'
import { quickChatHref } from '@/components/chat/quick-chat'
import { callCommand } from '@/lib/network/client'
import type { Learning } from '@/lib/learning/types'
import { act, loadApp, saveNotes, type AppBundle, type TimelineEvent } from './data'
import { buttonsFor, localInput, readNote, stageSuggestion, writeNote, type Button } from './logic'

const DISMISSED = 'cello:stage-suggestion:dismissed'
const readDismissed = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) ?? '[]')
  } catch {
    return []
  }
}

/** How an event reads in the timeline: who did it, as Cello words it. */
export const whoOf = (e: Pick<TimelineEvent, 'actor_label' | 'actor' | 'channel'>): string =>
  e.actor_label || actorWords(e.actor as Door['actor'], (e.channel ?? 'session') as Door['channel'])

function Event({ e }: { e: TimelineEvent }) {
  return (
    <li className="py-2">
      <p className="r-name">{e.sentence}</p>
      <p className="r-meta">
        {whoOf(e)}, {ago(e.created_at)}
        {e.cost_usd && e.cost_usd > 0 ? `, $${e.cost_usd.toFixed(2)}` : ''}
      </p>
      <details className="r-meta">
        <summary className="min-h-11 cursor-pointer leading-[44px]">Show what Cello did</summary>
        <dl className="space-y-1 pb-2">
          <div><dt className="inline">What: </dt><dd className="inline">{e.kind.replace(/[._]/g, ' ')}</dd></div>
          {e.step && <div><dt className="inline">Step: </dt><dd className="inline">{e.step.replace(/[._]/g, ' ')}</dd></div>}
          {(e.from_state || e.to_state) && <div><dt className="inline">State: </dt><dd className="inline">{[e.from_state ?? 'none', e.to_state ?? 'none'].join(' to ')}</dd></div>}
          <div><dt className="inline">Checked: </dt><dd className="inline">{e.trust === 'unconfirmed' ? 'Not confirmed' : 'Confirmed'}</dd></div>
          {e.model_calls ? <div><dt className="inline">Model requests: </dt><dd className="inline">{e.model_calls}{e.free_model ? ', on a free model' : ''}</dd></div> : null}
        </dl>
      </details>
    </li>
  )
}

export interface ApplicationPanelProps {
  bundle: AppBundle
  jobId: string
  dismissed: string[]
  busy?: boolean
  note?: string | null
  onButton: (b: Button) => void
  onStage: (stage: string) => void
  onDismiss: (messageId: string) => void
  onInterview: (at: string | null) => void
  onInstruction: (text: string) => void
  onNotes: (text: string) => void
  /** What Cello learned from this application, for a closed one. */
  took?: string[]
}

/** The group as the person reads it. Pure over its props, so each state has a fixture. */
export function ApplicationPanel({ bundle, dismissed, busy, note, onButton, onStage, onDismiss, onInterview, onInstruction, onNotes, took }: ApplicationPanelProps) {
  const { app, timeline, mail } = bundle
  const company = app.jobs?.companies?.name ?? 'The employer'
  const sentence = app.closed_reason
    ? `Closed: ${CLOSED_LABEL[app.closed_reason] ?? app.closed_reason}.`
    : statusSentence({ state: app.state as never, step: app.step, needsReason: app.needs_reason as never, needsDetail: app.needs_detail }, company) || (app.stage === 'applied' ? 'Applied.' : `Stage: ${app.stage}.`)
  const buttons = buttonsFor({ id: app.id, stage: app.stage, state: app.state, needs_reason: app.needs_reason, closed_reason: app.closed_reason, jobUrl: app.jobs?.url ?? null, company })
  const suggestion = stageSuggestion(app.stage, mail ? { id: mail.id, kind: mail.kind, sent_at: mail.sent_at, from: company } : null)
  const [instruction, setInstruction] = useState(app.instruction ?? '')
  const [notes, setNotes] = useState(readNote(app.notes))
  return (
    <section aria-labelledby="after-app" className="r-sheet space-y-5 p-6">
      <h2 id="after-app" className="r-title">Application</h2>
      <div className="space-y-2">
        <p className="r-body">{sentence}</p>
        {app.applied_at && <p className="r-meta">Applied {new Date(app.applied_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.</p>}
        {buttons.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {buttons.map((b, i) =>
              b.kind === 'link' ? (
                <Key key={b.label} asChild variant={i === 0 ? 'ink' : 'raised'}>
                  {b.external ? <a href={b.href} target="_blank" rel="noreferrer">{b.label}</a> : <Link href={b.href}>{b.label}</Link>}
                </Key>
              ) : (
                <Key key={b.label} variant={i === 0 ? 'ink' : 'raised'} disabled={busy} onClick={() => onButton(b)}>{b.label}</Key>
              ),
            )}
          </div>
        )}
      </div>

      {app.stage === 'offer' && !app.closed_reason && (
        <Key asChild variant="raised">
          <Link href={quickChatHref('Help me prepare to negotiate this offer.', { kind: 'application', ref: app.id }) ?? '/chat'}>Prepare to negotiate</Link>
        </Key>
      )}

      {app.closed_reason && took && took.length > 0 && (
        <div className="space-y-1">
          <h3 className="r-name">What Cello took from this</h3>
          <ul className="r-body list-disc pl-5">{took.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}

      {suggestion && !dismissed.includes(suggestion.messageId) && (
        <div className="space-y-2">
          <p className="r-body">{suggestion.sentence}</p>
          <div className="flex flex-wrap gap-2">
            <Key disabled={busy} onClick={() => onStage(suggestion.stage)}>Confirm</Key>
            <Key variant="ghost" onClick={() => onDismiss(suggestion.messageId)}>Not now</Key>
          </div>
        </div>
      )}

      <label className="block">
        <span className="r-meta block">Interview date and time</span>
        <input type="datetime-local" className="r-field min-h-11 w-full max-w-xs" defaultValue={localInput(app.interview_at)} onBlur={(e) => onInterview(e.target.value ? new Date(e.target.value).toISOString() : null)} />
      </label>

      <label className="block">
        <span className="r-meta block">Your instruction for this application (optional)</span>
        <textarea className="r-field min-h-[88px] w-full" maxLength={1000} value={instruction} onChange={(e) => setInstruction(e.target.value)} onBlur={() => instruction !== (app.instruction ?? '') && onInstruction(instruction)} />
      </label>

      <label className="block">
        <span className="r-meta block">Notes. Cello never reads these as instructions.</span>
        <textarea className="r-field min-h-[88px] w-full" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== readNote(app.notes) && onNotes(notes)} />
      </label>
      {note && <p className="r-meta" role="status">{note}</p>}

      {timeline.length > 0 && (
        <div>
          <h3 className="r-name">Timeline</h3>
          <ul className="divide-y divide-[var(--r-line)]">{timeline.map((e) => <Event key={e.id} e={e} />)}</ul>
        </div>
      )}
      <Link href="/applications" className="r-meta underline">All applications</Link>
    </section>
  )
}

export function ApplicationGroup({ jobId }: { jobId: string }) {
  const [bundle, setBundle] = useState<AppBundle | null | undefined>(undefined)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [took, setTook] = useState<string[]>([])

  const load = useCallback(() => loadApp(jobId).then(setBundle).catch(() => setBundle(null)), [jobId])
  useEffect(() => {
    setDismissed(readDismissed())
    void load()
  }, [load])
  const closed = Boolean(bundle?.app.closed_reason)
  const appId = bundle?.app.id
  // a closed application says what Cello learned from it, when a learning used it
  useEffect(() => {
    if (!closed || !appId) return
    callCommand<{ ok: boolean; items?: Learning[] }>('/api/settings/learned', 'learned.list', { status: 'active' })
      .then((r) => setTook((r.items ?? []).filter((l) => l.evidence.some((e) => e.id === appId)).map((l) => l.statement)))
      .catch(() => undefined)
  }, [closed, appId])

  async function run(what: () => Promise<void>, done: string) {
    setBusy(true)
    setNote(null)
    try {
      await what()
      setNote(done)
      await load()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not do that. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  if (!bundle) return null
  const id = bundle.app.id
  return (
    <ApplicationPanel
      bundle={bundle}
      jobId={jobId}
      dismissed={dismissed}
      busy={busy}
      note={note}
      took={took}
      onButton={(b) => b.kind === 'post' && run(() => act(id, b.action, b.body), 'Saved.')}
      onStage={(stage) => run(() => act(id, 'stage', { stage }), 'Moved.')}
      onDismiss={(messageId) => {
        const next = [...dismissed, messageId]
        setDismissed(next)
        // ponytail: a dismissed suggestion is remembered in this browser only; a stored dismissal arrives with the proposals store
        try {
          localStorage.setItem(DISMISSED, JSON.stringify(next))
        } catch {
          // a private window forgets it on reload
        }
      }}
      onInterview={(at) => run(() => act(id, 'interview-date', { at }), 'Saved.')}
      onInstruction={(text) => run(() => act(id, 'instruction', { text }), 'Saved.')}
      onNotes={(text) => run(() => saveNotes(id, writeNote(bundle.app.notes, text)), 'Saved.')}
    />
  )
}
