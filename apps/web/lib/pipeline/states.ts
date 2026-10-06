// States: the moves an application may make, and the sentence the person reads for each. SQL
// (pipeline_transition) enforces the caps, Pause and who may write what; this table is what the
// commands check before they ask, so an illegal move is a bug found in a test and never a surprise.
//
// Sentences are plain, sentence case, with no internal names (blueprint 7, the status table).

import type { ApplicationState, NeedsReason, StopCause } from './types'

export type MoveFrom = ApplicationState | 'none'

/** Every legal move. 'none' is a row with no state: saved, added by hand, imported or found in mail. */
export const LEGAL_MOVES: Record<MoveFrom, readonly ApplicationState[]> = {
  none: ['preparing', 'needs_you', 'sent', 'skipped'],
  preparing: ['preparing', 'needs_you', 'scheduled', 'ready', 'not_sent', 'paused', 'skipped', 'sent'],
  needs_you: ['preparing', 'ready', 'sent', 'skipped', 'paused'],
  scheduled: ['preparing', 'paused', 'skipped', 'not_sent'],
  ready: ['applying', 'sent', 'skipped', 'paused', 'preparing', 'needs_you'],
  // applying to applying is the Send step of Send for me: one more event, the same state
  applying: ['applying', 'sent', 'needs_you', 'ready'],
  // a retraction returns a wrongly marked send to Ready
  sent: ['confirmed', 'ready'],
  confirmed: [],
  not_sent: ['preparing', 'skipped'],
  skipped: ['preparing'],
  // Resume restores the state before the pause
  paused: ['preparing', 'needs_you', 'scheduled', 'ready'],
}

export function canMove(from: MoveFrom, to: ApplicationState): boolean {
  return LEGAL_MOVES[from].includes(to)
}

/** The states in which Cello is working or waiting on a clock, not on the person. */
export const WORKING_STATES: readonly ApplicationState[] = ['preparing', 'scheduled', 'applying']

const STOP_SENTENCE: Record<StopCause, (company: string) => string> = {
  sign_in: (c) => `${c}'s site needs you to sign in.`,
  account: (c) => `${c} needs an account. Sign in on ${c}'s site first, then click Fill on each page.`,
  site_check: (c) => `${c}'s site asked for a human check. Open it to finish; everything is filled.`,
  unreadable: (c) => `Cello cannot read ${c}'s form. Open it and click Fill on each page.`,
  unknown_field: () => 'A required question has no answer Cello may give. Finish it on the site.',
  prefilled: (c) => `${c}'s form had an answer already chosen. Check it and send it yourself.`,
  wrong_page: () => 'The apply link led somewhere else.',
  upload: () => 'Cello could not attach the file. Finish it on the site.',
  form_changed: () => 'The form changed since Cello prepared it. Open it and click Fill.',
  no_submit: () => 'Cello could not find the one Send button. Send it yourself.',
  form_error: () => 'The site showed an error after Send. Check it on the site.',
  interrupted: () => 'Your browser closed before Cello sent this. Open it and click Fill.',
}

/** The button of a stop: what the person does about it. */
export const STOP_BUTTON = 'Open on site'

export interface StatusInput {
  state: ApplicationState | null
  step: string | null
  needsReason: NeedsReason | null
  needsDetail: Record<string, unknown> | null
}

const trim = (s: string) => s.replace(/[.\s]+$/, '')
const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s)

/**
 * The one sentence for an application's state. `company` is the employer's name from its row;
 * `autoReason` is why Send for me may not send a ready application, when it is on (lib/fill).
 */
export function statusSentence(a: StatusInput, company: string, autoReason: string | null = null): string {
  switch (a.state) {
    case null:
      return ''
    case 'preparing':
      return a.step ? `Cello is preparing this: ${lower(trim(a.step))}.` : 'Cello is preparing this.'
    case 'scheduled':
      return a.step ? `Waiting: ${lower(trim(a.step))}.` : 'Waiting to continue.'
    case 'ready':
      return autoReason ? `Needs you: ready to send. ${autoReason}` : 'Needs you: ready to send.'
    case 'applying':
      return a.step ? `${trim(a.step)}.` : 'Filling the form.'
    case 'sent':
      return 'Sent.'
    case 'confirmed':
      return `${company} confirmed it.`
    case 'not_sent':
      return a.step ? `Not sent: ${lower(trim(a.step))}.` : 'Not sent.'
    case 'skipped':
      return 'Skipped by you.'
    case 'paused':
      return 'Paused.'
    case 'needs_you':
      return needsSentence(a, company)
  }
}

function needsSentence(a: StatusInput, company: string): string {
  switch (a.needsReason) {
    case 'approve_resume':
      return 'Needs you: approve the tailored resume.'
    case 'answer':
      return 'Needs you: a question Cello will not guess.'
    case 'duplicate': {
      const on = typeof a.needsDetail?.sent_on === 'string' ? a.needsDetail.sent_on : null
      return on ? `Needs you: you may have applied on ${on}.` : 'Needs you: you may have applied already.'
    }
    case 'your_turn': {
      const cause = a.needsDetail?.cause as StopCause | undefined
      return `Needs you: ${cause && cause in STOP_SENTENCE ? STOP_SENTENCE[cause](company) : 'finish this on the site.'}`
    }
    case 'check_sent':
      return 'Needs you: did you send it?'
    case 'reconnect':
      return 'Needs you: reconnect Gmail.'
    case 'budget':
      return 'Needs you: the monthly cap is reached.'
    case 'wait_computer':
      return 'Waiting for your computer.'
    default:
      return 'Needs you.'
  }
}
