// The turn after work that went to the background or fanned out: written by code from the rows, never by a model.
// What was done comes from the turn's worker rows; what needs the person from the applications Cello attached.

import type { AdminClient } from '@/lib/harness/types'
import { statusSentence } from '@/lib/pipeline/states'

type Part = { about: { kind: 'application'; ref: string }[]; text: string }

const DONE = ['done', 'partial']
/** The summary of a row that was in flight when its request died: its work ran again on a new row. */
export const INTERRUPTED = 'Interrupted. Cello picked this up again.'
const KINDS: [commands: string[], say: (n: number) => string][] = [
  [['applications.start'], (n) => `${n} started`],
  [['documents.draft'], (n) => `${n} drafted`],
  [['research', 'companies.research'], (n) => `${n} researched`],
]

export interface TurnApplication {
  id: string
  job_id: string
  state: string
  step: string | null
  needs_reason: string | null
  needs_detail: Record<string, unknown> | null
  /** "Title at Company", or the title alone. */
  name: string
  company: string
}

/** The applications this turn made, found two ways so a start that was cut short is not missed: the chat holds them (attached with the turn's id) and their created event carries the turn's id. Whatever state the turn's row ended in. */
export async function turnApplications(db: AdminClient, userId: string, chatId: string, turnId: string): Promise<TurnApplication[]> {
  const { data: tiles } = await db.from('chat_attachments').select('ref, prov').eq('chat_id', chatId).eq('user_id', userId).eq('kind', 'application').eq('origin', 'model').is('removed_at', null)
  const { data: made } = await db.from('pipeline_events').select('application_id, payload').eq('user_id', userId).eq('kind', 'application.created').order('created_at', { ascending: false }).limit(200)
  const ids = [
    ...new Set([
      ...((tiles as { ref: { id?: string }; prov: { turn_id?: string } | null }[] | null) ?? []).filter((t) => t.prov?.turn_id === turnId && t.ref?.id).map((t) => t.ref.id as string),
      ...((made as { application_id: string | null; payload: { turn_id?: string } | null }[] | null) ?? []).filter((e) => e.application_id && e.payload?.turn_id === turnId).map((e) => e.application_id as string),
    ]),
  ]
  if (!ids.length) return []
  const { data: apps } = await db.from('applications').select('id, job_id, state, step, needs_reason, needs_detail').eq('user_id', userId).in('id', ids)
  const rows = (apps as Omit<TurnApplication, 'name' | 'company'>[] | null) ?? []
  const { data: jobs } = rows.length ? await db.from('person_jobs').select('id, title, viewer_company_name').eq('viewer_id', userId).in('id', rows.map((a) => a.job_id)) : { data: [] }
  return rows.map((a) => {
    const job = ((jobs as { id: string; title: string; viewer_company_name: string | null }[] | null) ?? []).find((j) => j.id === a.job_id)
    const company = job?.viewer_company_name ?? ''
    return { ...a, company, name: job ? (company ? `${job.title} at ${company}` : job.title) : 'this application' }
  })
}

/** One code-written turn: what was done and what needs the person. False when there was nothing to say or it was written already. */
export async function writeRollup(db: AdminClient, userId: string, chatId: string, turnId: string): Promise<boolean> {
  // The check is in code, not in the query: a prov filter is not portable across the stores this runs on.
  const { data: written } = await db.from('chat_turns').select('prov').eq('chat_id', chatId).eq('user_id', userId).eq('kind', 'cello').eq('origin', 'code')
  if (((written as { prov: { rule?: string; turn_id?: string } | null }[] | null) ?? []).some((r) => r.prov?.rule === 'rollup' && r.prov.turn_id === turnId)) return false

  const { data: tasks } = await db.from('agent_tasks').select('command, status, summary, object').eq('user_id', userId).eq('turn_id', turnId).neq('command', 'chat.turn')
  type Row = { command: string; status: string; summary: string | null; object: { ref?: string } | null }
  const all = (tasks as Row[] | null) ?? []
  // A row cut short by a dead request is not a failure when the same piece of work then ran again and finished.
  const rows = all.filter((r) => !(r.summary === INTERRUPTED && all.some((o) => o !== r && o.command === r.command && o.object?.ref && o.object.ref === r.object?.ref && DONE.includes(o.status))))
  const count = (pick: (r: Row) => boolean) => rows.filter(pick).length
  const done = rows.filter((r) => DONE.includes(r.status))
  const named = KINDS.flatMap(([commands, say]) => {
    const n = done.filter((r) => commands.includes(r.command)).length
    return n ? [say(n)] : []
  })
  const other = done.length - done.filter((r) => KINDS.some(([commands]) => commands.includes(r.command))).length
  if (other) named.push(`finished ${other} other task${other === 1 ? '' : 's'}`)
  const failed = count((r) => r.status === 'failed')
  const stopped = count((r) => r.status === 'stopped')
  const doneText = `Done: ${named.length ? named.join(', ') : 'nothing finished'}.${failed ? ` ${failed} could not finish.` : ''}${stopped ? ` ${stopped} stopped by you.` : ''}`

  // A role the person stopped still counts when its application exists: it is ready, or waiting on them, whatever the row says.
  const waiting = (await turnApplications(db, userId, chatId, turnId)).filter((a) => a.state === 'needs_you' || a.state === 'ready')

  const needs: Part[] = waiting.map((a) => {
    const company = a.company
    const link = `[${a.name}](cello:application/${a.id})`
    const about = [{ kind: 'application' as const, ref: a.id }]
    if (a.needs_reason === 'approve_resume') return { about, text: `Needs you: approve the tailored resume for ${link}.` }
    const why = statusSentence({ state: a.state as never, step: a.step, needsReason: a.needs_reason as never, needsDetail: a.needs_detail }, company).replace(/^Needs you:? ?/, '')
    return { about, text: `Needs you on ${link}${why ? `: ${why}` : '.'}` }
  })
  if (!rows.length && !needs.length) return false

  const parts: Part[] = [{ about: [], text: doneText }, ...needs]
  const { error } = await db.from('chat_turns').insert({
    user_id: userId,
    chat_id: chatId,
    kind: 'cello',
    origin: 'code',
    answer: parts.map((p) => p.text).join('\n\n'),
    prov: { step: 'chat', rule: 'rollup', turn_id: turnId },
    parts,
    links: needs.map((n) => ({ kind: 'application', table: 'applications', id: n.about[0].ref, role: 'named' })),
  })
  if (error) return false
  await db.from('chats').update({ last_turn_at: new Date().toISOString() }).eq('id', chatId).eq('user_id', userId)
  return true
}
