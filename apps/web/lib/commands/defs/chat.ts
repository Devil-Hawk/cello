// Chat's commands: find, read and compare the person's roles, read a company, recall an earlier chat and keep an
// answer. Each is code over stored rows; every string a model may quote comes back inside a `things` list, and the
// loop turns each thing into a result the answer check reads (lib/chat/agent.ts). Nothing here reaches a model.

import { z } from 'zod'
import { createArtifact } from '@/lib/agents/artifacts'
import { roleView } from '@/lib/agents/scoring-port'
import { readCard } from '@/lib/chat/cards'
import { findRoles, MAX_FOUND } from '@/lib/chat/find-roles'
import { recall } from '@/lib/chat/recall'
import { recalledThing } from '@/lib/chat/recalled'
import { madeThing, ThingSchema, type Thing } from '@/lib/chat/things'
import { getMemoryStore } from '@/lib/memory/mem0-store'
import { CommandRefusal, defineCommand, type AnyCommand, type CommandContext } from '../define'
import { codeText, untrustedText } from '../text'

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
const cell = (v: string | null | undefined) => (v ?? 'not stated').replace(/\s+/g, ' ').replace(/\|/g, '/').trim()

async function roleThing(ctx: CommandContext, id: string): Promise<Thing | null> {
  const v = await roleView(ctx.admin(), ctx.userId, id)
  if (!v) return null
  return { kind: 'role', id, title: v.title ?? 'Untitled role', company: v.company, place: v.location, pay: v.salary, chance: v.chance, posted: day(v.postedAt), notes: [...v.requirements.covered.map((s) => `Covered: ${s}`), ...v.requirements.missing.map((s) => `Missing: ${s}`)] }
}

const things = z.array(ThingSchema).max(60)

export const rolesFind = defineCommand({
  id: 'roles.find',
  label: 'Find roles',
  input: z.strictObject({
    type: z.string().max(100).optional(),
    place: z.string().max(100).optional(),
    words: z.string().max(100).optional(),
    interested: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_FOUND).default(5),
    order: z.enum(['newest', 'ranked']).optional(),
  }),
  output: z.object({ sentence: codeText(400), matched: z.number().int(), things }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T3',
  async run(ctx, input) {
    const found = await findRoles(ctx.admin(), ctx.userId, input)
    return { sentence: found.sentence, matched: found.matched, things: found.things }
  },
})

export const rolesGet = defineCommand({
  id: 'roles.get',
  label: 'Read a role',
  input: z.strictObject({ id: z.string().max(100) }),
  output: z.object({ sentence: codeText(200), things }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T21',
  async run(ctx, input) {
    const t = await roleThing(ctx, input.id)
    return t ? { sentence: `Read ${t.title}.`, things: [t] } : { sentence: 'That role is not in your stored roles.', things: [] }
  },
})

export const companiesGet = defineCommand({
  id: 'companies.get',
  label: 'Read a company',
  input: z.strictObject({ id: z.string().max(100) }),
  output: z.object({ sentence: codeText(200), things }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T12',
  async run(ctx, input) {
    const c = await readCard(ctx.admin(), ctx.userId, { kind: 'company', ref: input.id })
    if (!c || c.kind !== 'company') return { sentence: 'That company is not in your account.', things: [] }
    const notes = [`${c.openCount} open roles stored`, `${c.keptCount} applications`, c.following ? 'You follow it' : 'You do not follow it', c.domain && `Site: ${c.domain}`].filter((n): n is string => Boolean(n))
    return { sentence: `Read ${c.name}.`, things: [{ kind: 'company' as const, id: c.id, title: c.name, company: c.name, place: null, pay: null, chance: null, posted: null, notes }] }
  },
})

export const rolesCompare = defineCommand({
  id: 'roles.compare',
  label: 'Compare roles',
  input: z.strictObject({ ids: z.array(z.string().max(100)).min(2).max(12) }),
  output: z.object({ sentence: codeText(300), table: untrustedText(8000), artifact_id: codeText(100), version: z.number().int(), things }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T21',
  async run(ctx, input) {
    const read = await Promise.all([...new Set(input.ids)].map((id) => roleThing(ctx, id)))
    const roles = read.filter((r): r is Thing => r !== null)
    if (roles.length < 2) throw new CommandRefusal(404, 'Fewer than two of those roles are in your stored roles.', 'not_found')
    // The table is code: every cell is the stored value, or "not stated".
    const table = [
      '| Role | Company | Place | Chance | Pay as stated | Posted |',
      '| --- | --- | --- | --- | --- | --- |',
      ...roles.map((r) => `| ${[r.title, r.company, r.place, r.chance, r.pay, r.posted].map(cell).join(' | ')} |`),
    ].join('\n')
    const title = `Compare ${roles.length} roles`
    const made = await createArtifact(ctx.admin(), { userId: ctx.userId, type: 'comparison', title, author: 'cello', content: { text: table, role_ids: roles.map((r) => r.id) }, about: roles.map((r) => ({ kind: 'job' as const, ref: r.id })) })
    if (ctx.chat) await ctx.admin().from('artifacts').update({ chat_turn_id: ctx.chat.turnId }).eq('id', made.id).eq('user_id', ctx.userId)
    const sentence = `Compared ${roles.length} of your stored roles in a table.`
    return { sentence, table, artifact_id: made.id, version: made.version, things: [...roles, madeThing(made.id, title, [`Comparison table, version ${made.version}`, table])] }
  },
})

export const peopleFind = defineCommand({
  id: 'people.find',
  label: 'Find a person',
  input: z.strictObject({ name: z.string().min(1).max(100), limit: z.number().int().min(1).max(5).default(3) }),
  output: z.object({ sentence: codeText(200), things }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'none',
  limits: { bucket: 'people' },
  measure: 'T12',
  async run(ctx, input) {
    const db = ctx.admin()
    // % and _ are the pattern's own marks; a name seldom holds them.
    const like = `%${input.name.replace(/[%_\\]/g, ' ').replace(/\s+/g, ' ').trim()}%`
    const { data } = await db.from('contacts').select('id, name, title, companies(name)').eq('user_id', ctx.userId).ilike('name', like).limit(input.limit)
    const rows = (data as { id: string; name: string; title: string | null; companies: { name: string } | { name: string }[] | null }[] | null) ?? []
    const found: Thing[] = []
    for (const r of rows) {
      const { data: m } = await db.from('messages').select('sent_at, subject, excerpt').eq('user_id', ctx.userId).eq('contact_id', r.id).eq('direction', 'in').order('sent_at', { ascending: false }).limit(1)
      const last = ((m as { sent_at: string; subject: string; excerpt: string | null }[] | null) ?? [])[0]
      const company = (Array.isArray(r.companies) ? r.companies[0] : r.companies)?.name ?? null
      found.push({ kind: 'person', id: r.id, title: r.name, company, place: null, pay: null, chance: null, posted: null, notes: [r.title && `Title: ${r.title}`, last && `Wrote ${day(last.sent_at)}: ${last.excerpt ?? last.subject}`].filter((n): n is string => Boolean(n)) })
    }
    return { sentence: found.length ? `Found ${found.length} of your contacts named like "${input.name}".` : `None of your contacts is named like "${input.name}".`, things: found }
  },
})

export const chatRecall = defineCommand({
  id: 'chat.recall',
  label: 'From your earlier chats',
  input: z.strictObject({ words: z.string().min(1).max(300) }),
  output: z.object({ sentence: codeText(200), things }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'S22',
  async run(ctx, input) {
    const hits = await recall(ctx.admin(), getMemoryStore(), ctx.userId, input.words)
    return { sentence: hits.length ? `Found ${hits.length} from your earlier chats.` : 'Nothing in your earlier chats matches.', things: hits.flatMap(recalledThing) }
  },
})

export const chatKeep = defineCommand({
  id: 'chat.keep',
  label: 'Keep this',
  input: z.strictObject({ artifact_id: z.string().max(100) }),
  output: z.object({ kept: z.boolean() }),
  callers: ['session'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'S22',
  async run(ctx, input) {
    const db = ctx.admin()
    const { data: art } = await db.from('artifacts').select('id, current_version').eq('id', input.artifact_id).eq('user_id', ctx.userId).maybeSingle()
    if (!art) throw new CommandRefusal(404, 'That is not in your account.', 'not_found')
    const { error } = await db.from('artifact_versions').update({ confirmed_at: new Date().toISOString() }).eq('artifact_id', input.artifact_id).eq('version', (art as { current_version: number }).current_version)
    if (error) throw new Error('Could not keep that.')
    return { kept: true }
  },
})

export const chatCommands: AnyCommand[] = [rolesFind, rolesGet, companiesGet, rolesCompare, peopleFind, chatRecall, chatKeep]
