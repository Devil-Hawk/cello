// Who made a move, in the person's words. The actor and the channel come from the door a call came
// through, never from an argument: a session route is the person, the clock is Cello, a stored rule
// is the person's rule, Chat and an assistant are Cello and say so, the extension is the browser.

import type { Actor, Channel } from './types'

export interface Door {
  actor: Actor
  channel: Channel
}

export const DOORS = {
  session: { actor: 'person', channel: 'session' },
  routine: { actor: 'schedule', channel: 'routine' },
  rule: { actor: 'rule', channel: 'routine' },
  chat: { actor: 'cello', channel: 'chat' },
  assistant: { actor: 'cello', channel: 'assistant' },
  agent: { actor: 'cello', channel: 'agent' },
  extension: { actor: 'extension', channel: 'extension' },
  inbox: { actor: 'email', channel: 'inbox' },
} as const satisfies Record<string, Door>

export type DoorName = keyof typeof DOORS

/** The timeline's word for who did it. `label` is an A2A token's label or a routine's instruction. */
export function actorWords(actor: Actor, channel: Channel | null, label?: string | null): string {
  switch (actor) {
    case 'person':
      return 'You'
    case 'schedule':
      return label === 'instruction' ? 'Your instruction' : 'Cello'
    case 'rule':
      return 'Your rule'
    case 'cello':
      if (channel === 'chat') return 'Cello, from Chat'
      if (channel === 'assistant') return 'Your assistant'
      if (channel === 'agent') return label ? `Another agent: ${label}` : 'Another agent'
      return 'Cello'
    case 'extension':
      return 'Your browser'
    case 'email':
      return 'From your email'
    case 'owner':
      return 'Cello'
  }
}
