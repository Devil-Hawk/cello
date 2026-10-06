'use client'

import { useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'

export type DoorState = 'idle' | 'checking' | 'free' | 'failed'

export const DOOR_LABEL = 'Use free models (OpenRouter, sign in with one tap)'
export const DOOR_CHECKING = 'Checking the key'
export const DOOR_FAILED = 'That key did not work. OpenRouter keys start with sk-or-.'
export const DOOR_FREE = 'Free models are on.'

/** The state the round trip left in the address (?models=free or ?models=failed). */
export function doorStateFromQuery(search: string): DoorState {
  const m = new URLSearchParams(search).get('models')
  return m === 'free' || m === 'failed' ? m : 'idle'
}

// The "Use free models" door. One tap signs in to OpenRouter by PKCE and brings
// a key back, so nobody pastes anything. It is offered on Welcome's Connect
// screen and in Settings, never as step one, and never to a demo.
export function OpenRouterDoor({ returnTo = '/welcome' }: { returnTo?: '/welcome' | '/settings' | '/today' | '/roles' }) {
  const [state, setState] = useState<DoorState>('idle')

  useEffect(() => {
    // Read after mount: the address is not known on the server.
    setState(doorStateFromQuery(window.location.search))
  }, [])

  return (
    <div className="space-y-2">
      <Key asChild variant="raised" aria-busy={state === 'checking'}>
        <a href={`/api/auth/openrouter/start?return=${encodeURIComponent(returnTo)}`} onClick={() => setState('checking')}>
          {state === 'checking' ? DOOR_CHECKING : DOOR_LABEL}
        </a>
      </Key>
      <p role={state === 'failed' ? 'alert' : undefined} aria-live="polite" className="r-body">
        {state === 'failed' ? DOOR_FAILED : state === 'free' ? DOOR_FREE : null}
      </p>
    </div>
  )
}
