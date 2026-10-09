// Intent routing for the three asks a person types most: find roles, compare my top few, draft a note to a company.
// Code reads the words, calls the same commands the loop would call (under the Chat door, so every limit and refusal
// of the registry holds), and uses a model only for what needs one: the two-sentence comparison and the draft text.
// Anything else, and anything with tiles attached, goes to the model loop as before.
//
// ponytail: a pattern per intent, not a classifier. A phrasing it does not know falls through to the loop; add a
// pattern here when a real phrasing falls through.

import { createArtifact } from '@/lib/agents/artifacts'
import { chatDoor, CommandRefusal, getCommand, runCommand } from '@/lib/commands'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { askModel } from '@/lib/models/ask'
import type { Ran } from '@/lib/models/choice'
import { unsupported, type ModelAnswer, type TurnResult } from './answer'
import { resolveRoleType } from './find-roles'
import { resultOf } from './recalled'
import { madeThing, type Thing } from './things'
import { withWorker } from './workers'
import type { AgentInput, AgentOutput } from './turn'

export type Intent =
  | { kind: 'find'; type: string | null; place: string | null; company: string | null; limit: number }
  | { kind: 'compare'; n: number }
  | { kind: 'draft'; company: string; ask: string }

const NUMS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, couple: 2, few: 3 }
const count = (w: string | undefined, fallback: number) => (w ? (/^\d+$/.test(w) ? Number(w) : (NUMS[w.toLowerCase()] ?? fallback)) : fallback)
const NUM_WORD = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten'

const FIND = new RegExp(`\\b(?:find|show|search(?: for)?|look(?:ing)? for|get|list|any)\\b(?:\\s+me)?\\s+(?:(?:the|some|any|all|my|new|open)\\s+)*(?:(${NUM_WORD})\\s+)?(.*?)\\s*\\b(?:roles?|jobs?|positions?|openings?)\\b(?:\\s+(in|near|around|based in|at|from)\\s+(.+?))?\\s*[.?!]*$`, 'i')
const COMPARE = new RegExp(`\\bcompare\\b.*\\b(?:top|best|first)\\s+(${NUM_WORD})\\b|\\bcompare\\b.*\\bmy\\s+(${NUM_WORD})\\s+(?:top|best)\\b`, 'i')
const DRAFT = /\b(?:draft|write|compose)\b.*\b(?:note|message|email|follow[- ]?up)\b/i

/** What a typed line asks for, when it is one of the three; null otherwise. `companies` are the person's stored names. */
export function routeIntent(typed: string, companies: string[] = []): Intent | null {
  const text = typed.replace(/\s+/g, ' ').trim()
  const cmp = text.match(COMPARE)
  if (cmp) return { kind: 'compare', n: Math.min(Math.max(count(cmp[1] ?? cmp[2], 3), 2), 6) }
  if (DRAFT.test(text)) {
    const lower = text.toLowerCase()
    const company = [...companies].sort((a, b) => b.length - a.length).find((c) => lower.includes(c.toLowerCase()))
    if (!company) return null
    const ask = text.match(/\b(?:asking(?: about)?|ask(?: about)?|about|regarding)\s+(.+?)[.?!]*$/i)?.[1] ?? ''
    return { kind: 'draft', company, ask }
  }
  const f = text.match(FIND)
  if (f) {
    let type = (f[2] ?? '').replace(/\b(?:remote)\b/i, '').replace(/\s+/g, ' ').trim()
    let place = f[3] && /^(in|near|around|based in)$/i.test(f[3]) ? f[4].trim() : null
    const company = f[3] && /^(at|from)$/i.test(f[3]) ? f[4].trim() : null
    if (/\bremote\b/i.test(f[2] ?? '') && !place) place = 'remote'
    if (/^(new|open|latest|recent|good|best|interesting)$/i.test(type)) type = ''
    return { kind: 'find', type: type || null, place, company, limit: Math.min(count(f[1], 5), 12) }
  }
  return null
}

interface Deps {
  db: AdminClient
  userId: string
  keys: DecryptedApiKeys
  ran: Ran
  signal?: AbortSignal
}

/** A model's text on one line, with a dash between two numbers (a pay range copied from the table) said as "to": the copy has no dashes. */
const plain = (t: string) => t.replace(/\s+/g, ' ').replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1 to $2').trim()

/** Two plain sentences on which of the roles to do first, from the stored table only; the first model that obeys wins. */
async function twoSentences(deps: Deps, table: string): Promise<{ text: string; model: string } | null> {
  const got = await askModel(
    deps.keys,
    deps.ran.model,
    {
      system:
        'You advise a job seeker. Reply with exactly two plain sentences and nothing else. Sentence one: which role to apply to first and why, citing the pay, place or posting date from the table. Sentence two: which role to look at next and why, from the table too. Use only facts in the table and never invent any. Do not use dashes, exclamation marks, lists or markdown.',
      prompt: `Roles:\n${table}`,
    },
    (t) => {
      const text = plain(t)
      return text.split(/(?<=[.?])\s+/).filter(Boolean).length === 2 && !/[\u2014\u2013!|*#]/.test(text) && unsupported(text, [table]).length === 0
    },
    deps.signal
  )
  return got ? { text: plain(got.text), model: got.model } : null
}

/** Code's own two sentences, for when no model obeyed: from the stored facts only, a stated pay first. */
function fallbackSentences(roles: Thing[]): string {
  const [a, b] = [...roles].sort((x, y) => Number(Boolean(y.pay)) - Number(Boolean(x.pay)))
  const at = (r: Thing) => `${r.title} at ${r.company ?? 'that employer'}`
  const why = a.pay ? `it is the one that states its pay, ${a.pay}` : a.posted ? `it was posted ${a.posted}, the freshest of the three` : 'it ranks first on your Roles list'
  return `Apply to ${at(a)} first, because ${why}. Look at ${at(b)} next${b.place ? `, which is in ${b.place}` : ''}.`
}

/** A note a careful person would send: the subject and body, or null when the model's text breaks a rule. Exported for its test. */
export function checkNote(text: string, input: { company: string; title: string; ask: string; evidence: string[] }): { subject: string; body: string } | null {
  const m = text.match(/^\s*Subject:\s*(.+?)\s*\n+([\s\S]+)$/i)
  if (!m) return null
  const subject = m[1].trim()
  const body = m[2].trim()
  if (/[\[\]<>{}\u2014\u2013!]/.test(`${subject} ${body}`)) return null
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  // The greeting and the sign-off are lines of their own; the sentences in between are the note.
  const middle = lines.filter((l, i) => !(i === 0 && /^(hello|hi|dear)\b/i.test(l) && l.length < 40) && !(i >= lines.length - 2 && l.length < 40 && (/^(thanks|thank you|best|regards|sincerely|kind regards)\b/i.test(l) || /^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(l))))
  const sentences = middle.join(' ').split(/(?<=[.?])\s+/).filter(Boolean)
  if (sentences.length < 4 || sentences.length > 6) return null
  const lower = body.toLowerCase()
  if (!lower.includes(input.company.toLowerCase())) return null
  const titleWords = input.title.toLowerCase().match(/[a-z]{4,}/g) ?? []
  if (titleWords.length && !titleWords.every((w) => lower.includes(w))) return null
  const askWords = input.ask.toLowerCase().match(/[a-z]{5,}/g) ?? []
  if (askWords.length && !askWords.some((w) => lower.includes(w.replace(/s$/, '')))) return null
  if (unsupported(body, input.evidence).length) return null
  return { subject, body }
}

export function routedAgent(deps: Deps, fallback: (input: AgentInput) => Promise<AgentOutput>, companyNames: () => Promise<string[]>): (input: AgentInput) => Promise<AgentOutput> {
  return async (input) => {
    // Tiles attached, a retry after a failed part, or a quoted selection: the loop's work, not a typed ask.
    if (input.screen || input.feedback) return fallback(input)
    const intent = routeIntent(input.typed, await companyNames())
    if (!intent) return fallback(input)

    const startedAt = new Date().toISOString()
    const ctx = chatDoor({ userId: deps.userId, typed: input.typed, chat: { chatId: input.chatId, turnId: input.turnId }, signal: deps.signal })
    const tools: NonNullable<AgentOutput['tools']> = []
    const sources: NonNullable<AgentOutput['sources']> = []
    const results: TurnResult[] = []
    const madeIds: string[] = []
    // The model that answered: the chosen one, unless it failed and the next free one stood in (then the turn says so).
    let usedModel = deps.ran.model
    const call = async (id: string, args: Record<string, unknown>): Promise<{ sentence?: string; things: Thing[] }> => {
      const def = getCommand(id)
      if (!def) throw new Error(`No command ${id}`)
      const out = (await runCommand(def, ctx, args)) as { sentence?: string; things?: Thing[] }
      tools.push({ label: def.label })
      for (const t of out.things ?? []) {
        results.push(resultOf(t))
        if (t.kind === 'made') madeIds.push(t.id)
        else sources.push({ title: t.title, host: t.company ?? 'Your stored roles' })
      }
      if (out.sentence) results.push({ object: null, text: out.sentence })
      return { sentence: out.sentence, things: out.things ?? [] }
    }
    // What code says in its own words is its own evidence (it can name a model and its numbers).
    const say = (text: string, cards: Thing[] = []): ModelAnswer => (results.push({ object: null, text }), { parts: [{ about: [], text }], cards: cards.filter((t) => t.kind === 'role').map((t) => ({ kind: 'role' as const, id: t.id })) })
    const done = async (answer: ModelAnswer): Promise<AgentOutput> => {
      // The model calls of this turn (the summary, the Writer) are tied to it, so its cost and model are on its own rows.
      await deps.db.from('llm_spend').update({ chat_turn_id: input.turnId }).eq('user_id', deps.userId).is('chat_turn_id', null).gte('created_at', startedAt)
      const made = madeIds.length ? (((await deps.db.from('artifacts').select('id, type, title, created_at').eq('user_id', deps.userId).in('id', madeIds)).data as { id: string; type: string; title: string; created_at: string }[] | null) ?? []) : []
      const ran: Ran = usedModel === deps.ran.model ? deps.ran : { ...deps.ran, model: usedModel, steppedDown: { wanted: { rung: deps.ran.rung, model: deps.ran.model, effort: deps.ran.effort }, why: 'model' } }
      return { answer, results, ran, tools, sources, made }
    }

    try {
      if (intent.kind === 'find') {
        // A role type the taxonomy does not know is matched as words in the title; never as "any role".
        const known = intent.type ? resolveRoleType(intent.type) : null
        const words = [!known && intent.type, intent.company].filter(Boolean).join(' ') || undefined
        const found = await call('roles.find', { ...(known ? { type: intent.type } : {}), ...(intent.place ? { place: intent.place } : {}), ...(words ? { words } : {}), limit: intent.limit, order: 'newest' })
        return done(say(found.sentence ?? 'Searched your stored roles.', found.things))
      }

      if (intent.kind === 'compare') {
        const top = await call('roles.find', { limit: intent.n, order: 'ranked' })
        if (top.things.length < 2) return done(say('You have fewer than two stored roles to compare. Pull some roles in first.'))
        const cmp = await call('roles.compare', { ids: top.things.map((t) => t.id) })
        const table = cmp.things.find((t) => t.kind === 'made')?.notes.find((n) => n.startsWith('|')) ?? ''
        const roles = cmp.things.filter((t) => t.kind === 'role')
        const said = await twoSentences(deps, table)
        if (said) usedModel = said.model
        const summary = said?.text ?? fallbackSentences(roles)
        return done({ parts: [{ about: [], text: cmp.sentence ?? 'Compared your top roles.' }, { about: [], text: summary }] })
      }

      // draft
      const jobs = await call('roles.find', { words: intent.company, limit: 1, order: 'ranked' })
      const job = jobs.things[0]
      if (!job) return done(say(`You have no stored role at ${intent.company} to write about. Add one first, then ask again.`))
      const { data: profile } = await deps.db.from('profiles').select('full_name, resume_text').eq('id', deps.userId).maybeSingle()
      const me = profile as { full_name: string | null; resume_text: string | null } | null
      const resume = (me?.resume_text ?? '').slice(0, 2500)
      const name = me?.full_name?.trim() || null
      if (!resume || !name) return done(say('Cello needs your resume to write a note in your voice. Add it on Your record, then ask again.'))
      const facts = `Role: ${job.title} at ${intent.company}${job.place ? `, ${job.place}` : ''}. Posted ${job.posted ?? 'a date not stated'}.`
      const errors: string[] = []
      const got = await withWorker(
        { db: deps.db, userId: deps.userId, threadId: input.chatId, chatId: input.chatId, turnId: input.turnId, model: deps.ran.model, rung: deps.ran.rung },
        { command: 'documents.draft', title: 'Writing a message' },
        () =>
          askModel(
            deps.keys,
            deps.ran.model,
            {
              maxTokens: 1800,
              system: `Write a short professional note from a job seeker to a recruiter. Output the first line as "Subject: ..." then a blank line, then the note: a greeting line (Hello,), four to six sentences, then a sign-off line (Thank you,) and the sender's name on the next line. Name the company and the role. Ask only the one thing requested${intent.ask ? `: ${intent.ask}` : ''}. The recruiter's name is unknown, so do not use one. Mention at most one strength, and only one that is in the resume excerpt; never invent an employer, number, date or skill. No brackets, no placeholders, no dashes, no exclamation marks.`,
              prompt: `Sender: ${name}\n${facts}\n\nResume excerpt:\n${resume}`,
            },
            (t) => checkNote(t, { company: intent.company, title: job.title, ask: intent.ask, evidence: [resume, facts, name] }) !== null,
            deps.signal,
            errors,
            'draft-outreach-message'
          )
      )
      if (!got) return done(say(`Cello could not write a note that passed its checks. ${errors.slice(0, 1).join(' ')} Try again in a minute, or pick another free model.`))
      usedModel = got.model
      const note = checkNote(got.text, { company: intent.company, title: job.title, ask: intent.ask, evidence: [resume, facts, name] }) as { subject: string; body: string }
      const made = await createArtifact(deps.db, { userId: deps.userId, type: 'message', title: `Note to ${intent.company}`, author: 'cello', content: { subject: note.subject, body: note.body, to_name: null, to_email: null, kind: 'initial' }, jobId: job.id, about: [{ kind: 'job', ref: job.id }] })
      await deps.db.from('artifacts').update({ chat_turn_id: input.turnId }).eq('id', made.id).eq('user_id', deps.userId)
      tools.push({ label: 'Write a draft' })
      madeIds.push(made.id)
      results.push(resultOf(madeThing(made.id, `Note to ${intent.company}`, [`Message, version ${made.version}`, note.subject, note.body])))
      return done(say(`Wrote version ${made.version} of a note to ${intent.company} about ${job.title}. Nothing was sent.`))
    } catch (e) {
      if (e instanceof CommandRefusal) return done(say(`${e.message}`))
      throw e
    }
  }
}
