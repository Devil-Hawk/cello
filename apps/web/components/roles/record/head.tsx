'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Key } from '@/components/ui/key'
import { QuickChatSlot } from '@/components/layout/quick-chat-slot'
import type { RoleFit } from '@/lib/scoring/types'
import { ChangeType } from '../change-type'
import { chanceWord, metaLine, typeLevel } from '../logic'
import { ReadMark } from '../read-mark'
import { postReaction } from '../reactions'
import { startApplication } from '../start-application'
import { LogoTile, RoleTitle } from '../role-tile'
import { applyTypeChanges } from '../type-change'
import type { RoleItem } from '../types'
import { useReactionState } from '../use-reaction-state'
import { useRoleReactions } from '../use-role-reactions'
import { useTypeChanges } from '../use-type-changes'
import { checkChance } from './fit-call'
import { FitStrip } from './fit-strip'

export interface RecordHeadProps {
  role: RoleItem
  /** The employer's posting, for Apply. */
  url: string | null
  /** The status sentence once acted ("You applied on Sep 12."). */
  status: string | null
  /** Every type Change type offers. */
  typeOptions: readonly { id: string; label: string }[]
  /** The posting lists requirements, so a chance can be checked against them. */
  hasRequirements: boolean
  /** The posting has a body to read at all. */
  hasPosting: boolean
}

// The calm first screen of the record: who, what, where and for how much as the
// employer stated it, one line of Cello's read, the fit strip, and the actions. Until K21 sends
// for the person, Apply opens the employer's site and asks whether they applied.
export function RecordHead({ role: read, url, status, typeOptions, hasRequirements, hasPosting }: RecordHeadProps) {
  const typed = useTypeChanges()
  const role = applyTypeChanges([read], typed.changes)[0]
  const { state, dispatch, now } = useReactionState()
  const { keys, panel } = useRoleReactions({ id: role.id, reaction: role.reaction?.reaction ?? null, state, dispatch, now, surface: 'record' })
  const [step, setStep] = useState<'idle' | 'asked' | 'started' | 'applied'>(status ? 'applied' : 'idle')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The chance as read, replaced by the check the person asks for here.
  const [checked, setChecked] = useState<RoleFit | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const chance = chanceWord(checked ? (checked.chance?.label ?? null) : role.chance)
  const says = checked?.want?.reason ?? role.read
  const tl = typeLevel(role)

  async function apply() {
    setError(null)
    setStarting(true)
    const r = await startApplication(role.id)
    setStarting(false)
    if (r.ok) setStep('started')
    else setError(r.sentence)
  }

  async function applied() {
    setError(null)
    if (await postReaction(role.id, { reaction: 'applied', surface: 'record' })) setStep('applied')
    else setError('Could not save that. Try again.')
  }

  async function check() {
    setChecking(true)
    setCheckError(null)
    const out = await checkChance(role.id)
    setChecking(false)
    if (out.ok) setChecked(out.fit)
    else setCheckError(out.message)
  }

  return (
    <header className="space-y-6">
      <div className="flex items-start gap-4">
        <LogoTile name={role.company} domain={role.domain} logoUrl={role.logoUrl} companyId={role.companyId} size={64} state={role.closed ? 'flat' : 'ring'} />
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="r-section">
            <RoleTitle id={role.id} title={role.title} company={role.company} companyId={role.companyId} />
          </h1>
          {tl && (
            <p className="r-body">
              {tl}
              {role.type?.origin === 'model' && <ReadMark className="ml-2" />}
            </p>
          )}
          <p className="r-body text-r-ink-2">{metaLine({ ...role, type: null, level: null, pasted: false }, now) || 'No place or pay stated.'}</p>
        </div>
      </div>
      <ChangeType item={role} options={typeOptions} change={typed.changes[role.id]} now={typed.now} onChange={typed.set} onUndo={typed.clear} />

      {(chance || says) && (
        <p className="r-body">
          <span className="r-meta mr-2">Cello&apos;s read</span>
          {[chance, says].filter(Boolean).join('. ')}
        </p>
      )}

      {!chance && !role.closed && (
        <div className="space-y-2">
          <Key variant="raised" onClick={check} disabled={checking}>
            {checking ? 'Checking' : 'Check my chance'}
          </Key>
          {checkError && (
            <p role="alert" className="r-meta">
              {checkError}
            </p>
          )}
        </div>
      )}

      {hasPosting && !hasRequirements && <p className="r-body">The posting does not list requirements, so Cello cannot check your chances.</p>}
      <FitStrip />

      {(step === 'applied' || status) && (
        <p className="r-title">
          {status ?? 'You applied.'}{' '}
          <Link href="/applications" className="r-body underline underline-offset-4">
            See it in Applications
          </Link>
        </p>
      )}
      {step === 'started' && <p className="r-title">Application started. Cello prepares it from your resume and stops before anything is sent.</p>}

      <div className="flex flex-wrap items-center gap-3">
        {step === 'idle' && (
          <Key onClick={apply} disabled={starting}>
            {starting ? 'Starting' : 'Apply'}
          </Key>
        )}
        {step === 'started' && (
          <>
            <Key asChild>
              <Link href="/applications">See it in Applications</Link>
            </Key>
            {url && (
              <Key asChild variant="raised">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  Open the posting <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
                </a>
              </Key>
            )}
          </>
        )}
        {step === 'asked' && (
          <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Did you apply">
            <span className="r-body">Did you apply?</span>
            <Key onClick={applied}>Yes</Key>
            <Key variant="raised" onClick={() => setStep('idle')}>
              Not yet
            </Key>
          </div>
        )}
        {keys}
        <Key asChild variant="ghost">
          <Link href={`/resume/${role.id}`}>Tailor resume</Link>
        </Key>
      </div>
      {step === 'idle' && <p className="r-meta">Cello prepares this from your resume. You send it.</p>}
      {panel}
      {error && (
        <p role="alert" className="r-meta">
          {error}
        </p>
      )}
      <div>
        <QuickChatSlot about={{ kind: 'role', ref: role.id }} />
      </div>
      {role.closed && (
        <p className="r-meta">
          This posting closed.{' '}
          <Link href="/roles" className="underline underline-offset-4">
            Back to Roles
          </Link>
        </p>
      )}
    </header>
  )
}
