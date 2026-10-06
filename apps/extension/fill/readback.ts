import type { ReadBack } from '../lib/fill-contract'
import { sensitivityOf } from './classify'

// What a submitted form may report back, and nothing else. Passwords, hidden
// inputs and challenge inputs are never read and never reported. A sensitive
// answer, an EEO answer or a consent is reported only as "answered by you". A
// file is reported by the name Cello itself attached.

export interface Snapshot {
  key: string
  type: string
  name: string
  label: string
  /** Text value, or for a radio group the selected option's label. Empty for a password. */
  value: string
  checked: boolean
  challenge: boolean
  /** The file name Cello attached to this input, from Cello's own state. */
  attachedName?: string
  /** Server category for the field, when it gave one. */
  category?: string
}

export function readBack(snaps: Snapshot[]): ReadBack {
  const out: ReadBack = {}
  for (const s of snaps) {
    if (s.challenge || s.type === 'hidden' || s.type === 'password') continue
    if (s.type === 'file') {
      if (s.attachedName) out[s.key] = { file: s.attachedName }
      continue
    }
    const answered = s.type === 'checkbox' ? s.checked : s.value.trim() !== ''
    if (sensitivityOf(s, s.category)) {
      if (answered) out[s.key] = { answered_by_you: true }
      continue
    }
    if (s.type === 'checkbox') out[s.key] = s.checked
    else if (answered) out[s.key] = s.value
  }
  return out
}
