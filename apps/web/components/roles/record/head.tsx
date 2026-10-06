'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Key } from '@/components/ui/key'
import { QuickChatSlot } from '@/components/layout/quick-chat-slot'
import { chanceWord, metaLine } from '../logic'
import { postReaction } from '../reactions'
import { LogoTile, RoleTitle } from '../role-tile'
import type { RoleItem } from '../types'
import { useReactionState } from '../use-reaction-state'
import { useRoleReactions } from '../use-role-reactions'

export interface RecordHeadProps {
  role: RoleItem
  /** The employer's posting, for Apply. */
  url: string | null
  /** The status sentence once acted ("You applied on Sep 12."). */
  status: string | null
}

// The calm first screen of the record: who, what, where and for how much as the
// employer stated it, one line of Cello's read, and the actions. Until K21 sends
// for the person, Apply opens the employer's site and asks whether they applied.
export function RecordHead({ role, url, status }: RecordHeadProps) {
  const { state, dispatch, now } = useReactionState()
  const { keys, panel } = useRoleReactions({ id: role.id, reaction: role.reaction?.reaction ?? null, state, dispatch, now, surface: 'record' })
  const [step, setStep] = useState<'idle' | 'asked' | 'applied'>(status ? 'applied' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const chance = chanceWord(role.chance)

  async function applied() {
    setError(null)
    if (await postReaction(role.id, { reaction: 'applied', surface: 'record' })) setStep('applied')
    else setError('Could not save that. Try again.')
  }

  return (
    <header className="space-y-6">
      <div className="flex items-start gap-4">
        <LogoTile name={role.company} domain={role.domain} logoUrl={role.logoUrl} companyId={role.companyId} size={64} state={role.closed ? 'flat' : 'ring'} />
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="r-section">
            <RoleTitle id={role.id} title={role.title} company={role.company} companyId={role.companyId} />
          </h1>
          <p className="r-body text-r-ink-2">{metaLine(role, now) || 'No place or pay stated.'}</p>
        </div>
      </div>

      {(chance || role.read) && (
        <p className="r-body">
          <span className="r-meta mr-2">Cello&apos;s read</span>
          {[chance, role.read].filter(Boolean).join('. ')}
        </p>
      )}

      {(step === 'applied' || status) && <p className="r-title">{status ?? 'You applied.'}</p>}

      <div className="flex flex-wrap items-center gap-3">
        {step === 'idle' && url && (
          <Key
            asChild
            onClick={() => {
              setStep('asked')
            }}
          >
            <a href={url} target="_blank" rel="noopener noreferrer">
              Apply <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Key>
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
      </div>
      {step === 'idle' && url && <p className="r-meta">Cello prepares this from your resume. You send it.</p>}
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
