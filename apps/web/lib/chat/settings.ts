// chat.settings: the model, the effort, the mode (Ask first or Hands-off, null to follow Settings), "Ask before each
// change" and the tool groups switched off, kept on the chat; and the person's default for new chats. A choice is checked every time it is written and every time it is read:
// above the person's highest, or a paid model on a free rung, is refused and never stored.

import { z } from 'zod'
import type { AdminClient } from '@/lib/harness/types'
import { ALLOWED_MODELS, getModelInfo } from '@/lib/models'
import { resolveChoice, validateChoice, withinCeiling, type ChoiceLimits, type ChoiceRung, type ModelChoice, type Ran } from '@/lib/models/choice'
import { isPaused, readPipelineSettings } from '@/lib/pipeline/settings'
import { resolveMode, type Mode, type ResolvedMode } from './mode'
import type { Refusal } from './types'

/** The twelve tools, as groups the person can switch off for a chat. */
export const TOOL_GROUPS = ['roles', 'companies', 'research', 'people', 'applications', 'documents', 'conversations', 'material', 'your_tools', 'my_record', 'today', 'propose'] as const

const Body = z.strictObject({
  choice: z.unknown().optional(),
  review: z.boolean().optional(),
  tools_off: z.array(z.enum(TOOL_GROUPS)).max(TOOL_GROUPS.length).optional(),
  /** This chat's mode; null follows Settings. */
  mode: z.enum(['ask', 'hands_off']).nullable().optional(),
  /** Also make it the person's choice for new chats. */
  as_default: z.boolean().optional(),
})

export interface RungInfo {
  rung: ChoiceRung
  label: string
  /** Why it cannot be picked, in the picker's words; empty when it can. */
  why: string
  models: { id: string; label: string }[]
}

const FREE_LABEL = (id: string) => id.replace(/^[^/]*\//, '').replace(/:free$/, '')

/** The ladder as the picker draws it: every rung, those above the person's highest or not set up greyed with the reason. */
export function describeRungs(limits: ChoiceLimits, freeModels: string[]): RungInfo[] {
  const why = (rung: ChoiceRung) => (!withinCeiling(rung, limits.ceiling) ? 'Above your highest. Change in Settings.' : limits.available.includes(rung) ? '' : 'Not set up.')
  return [
    { rung: 'R2', label: 'This computer', why: why('R2'), models: [] },
    { rung: 'R3', label: 'Free models', why: why('R3'), models: freeModels.map((id) => ({ id, label: FREE_LABEL(id) })) },
    { rung: 'R4', label: 'Your own key', why: why('R4'), models: ALLOWED_MODELS.map((id) => ({ id, label: getModelInfo(id)?.label ?? id })) },
  ]
}

export interface SettingsView {
  /** What the next turn runs on, with its step down when the stored choice cannot run. Null when nothing can. */
  ran: Ran | null
  rungs: RungInfo[]
  /** The chat's own mode (null follows Settings), Settings' mode, what the next turn without a keyword runs under, and the facts that hold Hands-off (so the page can resolve a pick before the chat exists). */
  mode: { chat: Mode | null; settings: Mode; resolved: ResolvedMode; facts: { sendForMe: boolean; paused: boolean; isDemo: boolean } }
  review: boolean
  toolsOff: string[]
}

type ChatSettings = { review?: boolean; tools_off?: string[]; mode?: Mode }
type Prefs = Record<string, unknown>

async function readProfile(db: AdminClient, userId: string): Promise<{ prefs: Prefs; isDemo: boolean }> {
  const { data } = await db.from('profiles').select('preferences, is_demo').eq('id', userId).maybeSingle()
  const row = data as { preferences: Prefs | null; is_demo: boolean | null } | null
  return { prefs: row?.preferences && typeof row.preferences === 'object' ? row.preferences : {}, isDemo: row?.is_demo === true }
}

const readPrefs = async (db: AdminClient, userId: string): Promise<Prefs> => (await readProfile(db, userId)).prefs

/** One chat's settings (or a new chat's, with `chatId` null), resolved against what the person allows. */
export async function readSettings(db: AdminClient, userId: string, chatId: string | null, limits: ChoiceLimits, freeModels: string[] = [limits.route('R3')]): Promise<SettingsView | null> {
  const { prefs, isDemo } = await readProfile(db, userId)
  let stored: unknown = null
  let settings: ChatSettings = {}
  if (chatId) {
    const { data } = await db.from('chats').select('model_choice, settings').eq('id', chatId).eq('user_id', userId).maybeSingle()
    if (!data) return null
    stored = (data as { model_choice: unknown }).model_choice
    settings = ((data as { settings: ChatSettings | null }).settings ?? {}) as ChatSettings
  }
  const pipeline = readPipelineSettings(prefs)
  const chatMode = settings.mode === 'ask' || settings.mode === 'hands_off' ? settings.mode : null
  const facts = { sendForMe: pipeline.send.mode === 'auto', paused: isPaused(pipeline), isDemo }
  return {
    ran: resolveChoice([stored, prefs.chat_choice], limits),
    rungs: describeRungs(limits, freeModels),
    mode: { chat: chatMode, settings: pipeline.mode, resolved: resolveMode({ chat: chatMode, settings: pipeline.mode, ...facts }), facts },
    review: settings.review === true,
    toolsOff: (settings.tools_off ?? []).filter((t) => (TOOL_GROUPS as readonly string[]).includes(t)),
  }
}

async function saveDefault(db: AdminClient, userId: string, choice: ModelChoice) {
  // ponytail: read, merge, write like Settings > Models does; two saves at the same instant keep the last. A save that
  // lands while set_autonomy changed the guarded pipeline object is refused (42501) and read again once.
  for (let tries = 0; ; tries++) {
    const prefs = await readPrefs(db, userId)
    const { error } = await db.from('profiles').update({ preferences: { ...prefs, chat_choice: choice } }).eq('id', userId)
    if (!error || error.code !== '42501' || tries > 0) return
  }
}

/**
 * Writes what the person changed. A choice above their highest is refused and nothing is stored.
 * With no chat (`chatId` null) the only thing that can be written is the choice for new chats.
 */
export async function writeSettings(db: AdminClient, userId: string, chatId: string | null, body: unknown, limits: ChoiceLimits): Promise<{ ok: true } | Refusal | { ok: false; notFound: true }> {
  const parsed = Body.safeParse(body)
  if (!parsed.success) return { ok: false, error: 'That is not a setting.', fix: 'Send a model choice, a mode, Ask before each change, or tool groups.' }
  const { choice, review, tools_off, mode, as_default } = parsed.data
  let checked: ModelChoice | null = null
  if (choice !== undefined) {
    const v = validateChoice(choice, limits.ceiling)
    if (!v.ok) return v
    checked = v.choice
  }
  if (!chatId) {
    if (!checked || !as_default) return { ok: false, error: 'Say which chat.', fix: 'Without a chat, only a choice for new chats can be saved.' }
    await saveDefault(db, userId, checked)
    return { ok: true }
  }
  const { data: chat } = await db.from('chats').select('settings').eq('id', chatId).eq('user_id', userId).maybeSingle()
  if (!chat) return { ok: false, notFound: true }
  const settings = { ...(((chat as { settings: ChatSettings | null }).settings ?? {}) as ChatSettings) }
  if (review !== undefined) settings.review = review
  if (tools_off !== undefined) settings.tools_off = [...new Set(tools_off)]
  if (mode === null) delete settings.mode
  else if (mode !== undefined) settings.mode = mode
  await db.from('chats').update({ ...(checked ? { model_choice: checked } : {}), settings }).eq('id', chatId).eq('user_id', userId)
  if (checked && as_default) await saveDefault(db, userId, checked)
  return { ok: true }
}
