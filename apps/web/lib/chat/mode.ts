// The autonomy mode of a Chat turn, decided by code before anything runs. Two modes: "Ask first" (find, research,
// draft and tailor run alone; the tailored resume waits for Approve; nothing is submitted) and "Hands-off" (an
// application Chat starts may be prepared and handed to Send for me without a stop). Hands-off is asked for by a
// keyword in the typed line, by the chat's own setting, or by Settings, in that order; it is effective only when
// Send for me is on, Cello is not paused and the account is not a demo, otherwise the turn runs as Ask first and
// the Sources and tools line says why. A model never raises the mode: a posting or an email could talk it into it.

export type Mode = 'ask' | 'hands_off'

/** The word that turns Hands-off on for one turn. One constant, so the owner can rename it. */
export const HANDS_OFF_WORD = 'handsoff'

export interface ResolvedMode {
  mode: Mode
  /** What asked for the mode that ran, or would have: the keyword, the chat's setting, Settings, or nothing. */
  why: 'keyword' | 'chat' | 'settings' | 'default'
  /** Why Hands-off was asked for but could not run. */
  blocked?: 'send_for_me_off' | 'paused' | 'demo'
}

export interface ModeInput {
  typed?: string | null
  /** The chat's own setting; null follows Settings. */
  chat?: Mode | null
  settings?: Mode
  sendForMe: boolean
  paused?: boolean
  isDemo?: boolean
}

const WORD = new RegExp(`(^|\\s)${HANDS_OFF_WORD}(?=$|[\\s.,;:!?])`, 'i')

/** True when the typed line holds the keyword as a word of its own. */
export const hasKeyword = (typed: string | null | undefined): boolean => Boolean(typed && WORD.test(typed))

/** The typed line without the keyword, for the router and the model. The stored line keeps it. */
export const stripKeyword = (typed: string): string => (hasKeyword(typed) ? typed.replace(WORD, '$1').replace(/\s{2,}/g, ' ').trim() : typed)

export function resolveMode(input: ModeInput): ResolvedMode {
  const why: ResolvedMode['why'] = hasKeyword(input.typed) ? 'keyword' : input.chat ? 'chat' : input.settings ? 'settings' : 'default'
  const asked: Mode = why === 'keyword' ? 'hands_off' : why === 'chat' ? (input.chat as Mode) : why === 'settings' ? (input.settings as Mode) : 'ask'
  if (asked === 'ask') return { mode: 'ask', why }
  const blocked: ResolvedMode['blocked'] | undefined = input.isDemo ? 'demo' : input.paused ? 'paused' : !input.sendForMe ? 'send_for_me_off' : undefined
  return blocked ? { mode: 'ask', why, blocked } : { mode: 'hands_off', why }
}

/** A scheduled task's autonomy as a mode, for when scheduled tasks are switched on (K27): only "act" is hands-off. */
export const modeOfTask = (autonomy: 'ask' | 'draft' | 'act' | null | undefined): Mode => (autonomy === 'act' ? 'hands_off' : 'ask')

export const MODE_LABELS: Record<Mode, string> = { ask: 'Ask first', hands_off: 'Hands-off' }

const BLOCKED_WORDS: Record<NonNullable<ResolvedMode['blocked']>, string> = {
  send_for_me_off: 'Hands-off needs Send for me on.',
  paused: 'Cello is paused.',
  demo: 'This is a demo, so nothing is sent.',
}

const WHY_WORDS: Record<ResolvedMode['why'], string> = { keyword: `because you typed ${HANDS_OFF_WORD}`, chat: 'set for this chat', settings: 'set in Settings', default: '' }

/** The Mode row under an answer: "Hands-off, because you typed handsoff." or "Ask first. Hands-off needs Send for me on." */
export function modeWords(r: ResolvedMode): string {
  if (r.blocked) return `${MODE_LABELS.ask}. ${BLOCKED_WORDS[r.blocked]}`
  const why = WHY_WORDS[r.why]
  return why ? `${MODE_LABELS[r.mode]}, ${why}.` : `${MODE_LABELS[r.mode]}.`
}
