// People and Network (K26): the commands over contacts, ties, profiles, memories and the follow-up rule.
// Every one is the person's own door (session) except where noted; a page, Chat and a workflow read the same
// rows through lib/network. Output is untrusted JSON (names and quotes come from mail), so none is listed to a model.

import { z } from 'zod'
import { defineCommand, CommandRefusal, type AnyCommand, type CommandContext } from '../define'
import { untrustedJson } from '../text'
import { readClient } from '../scope'
import { rpcSlotStore } from '../slots'
import { isOwner } from '@/lib/measures/owner'

const KINDS = ['recruiter', 'agency_recruiter', 'hiring_manager', 'referrer', 'other'] as const
const id = z.string().min(1).max(64)
const text = (n: number) => z.string().trim().max(n)

const db = (ctx: CommandContext) => {
  if (!ctx.supabase) throw new CommandRefusal(403, 'This action needs the person signed in.', 'proof')
  return ctx.supabase
}

const personCommand = <I extends z.ZodObject<any>>(def: {
  id: string
  label: string
  input: I
  measure: string
  kind?: 'code' | 'wf'
  egress?: 'none' | 'fixed'
  run: (ctx: CommandContext, input: z.output<I>) => Promise<unknown>
}) =>
  defineCommand({
    id: def.id,
    label: def.label,
    input: def.input,
    output: untrustedJson(),
    callers: ['session'],
    kind: def.kind ?? 'code',
    sends: false,
    egress: def.egress ?? 'none',
    measure: def.measure,
    run: def.run as never,
  })

async function owned(ctx: CommandContext, contactId: string) {
  const { data } = await db(ctx).from('contacts').select('id, name, email').eq('id', contactId).eq('user_id', ctx.userId).maybeSingle()
  if (!data) throw new CommandRefusal(404, 'That person is not in your network.', 'not_found')
  return data as { id: string; name: string; email: string | null }
}

export const peopleList = personCommand({
  id: 'people.list',
  label: 'Your people',
  input: z.strictObject({
    q: text(100).optional(),
    kind: z.enum(KINDS).optional(),
    address: z.enum(['employer', 'personal']).optional(),
    has_application: z.boolean().optional(),
    waiting_on_you: z.boolean().optional(),
    quiet: z.boolean().optional(),
    order: z.enum(['last', 'closest']).optional(),
    page: z.number().int().min(1).max(1000).optional(),
  }),
  measure: 'S18',
  async run(ctx, i) {
    const { listPeople } = await import('@/lib/network/people')
    return listPeople(readClient(ctx), ctx.userId, { q: i.q, kind: i.kind, address: i.address, hasApplication: i.has_application, waitingOnYou: i.waiting_on_you, quiet: i.quiet, order: i.order, page: i.page })
  },
})

export const peopleGet = personCommand({
  id: 'people.get',
  label: 'Open person',
  input: z.strictObject({ id }),
  measure: 'T30',
  async run(ctx, i) {
    const [{ getPerson }, { ruleLine }, { recall }] = await Promise.all([import('@/lib/network/people'), import('@/lib/network/nudges'), import('@/lib/network/memory')])
    const person = await getPerson(readClient(ctx), ctx.userId, i.id)
    if (!person) throw new CommandRefusal(404, 'That person is not in your network.', 'not_found')
    const memories = await recall(ctx.admin() as never, ctx.userId, { contactId: i.id }).catch(() => [])
    return { person, memories, rule: await ruleLine(readClient(ctx), ctx.userId, i.id) }
  },
})

const fields = {
  name: text(200).min(1),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  title: text(200).optional(),
  relationship: text(100).optional(),
  notes: text(4000).optional(),
  linkedin_url: z.string().trim().url().max(500).optional(),
  kind: z.enum(KINDS).optional(),
}

export const peopleAdd = personCommand({
  id: 'people.add',
  label: 'Add a person',
  input: z.strictObject(fields),
  measure: 'none',
  async run(ctx, i) {
    const { data, error } = await db(ctx)
      .from('contacts')
      .insert({ user_id: ctx.userId, ...i, source: 'person', address_kind: null, first_seen_at: new Date().toISOString() })
      .select('id')
      .single()
    if (error?.code === '23505') throw new CommandRefusal(409, 'You already have someone with that address.', 'duplicate')
    if (error) throw new Error('Could not add the person.')
    return { id: (data as { id: string }).id }
  },
})

export const peopleEdit = personCommand({
  id: 'people.edit',
  label: 'Edit person',
  input: z.strictObject({ id, name: fields.name.optional(), email: fields.email, title: fields.title, relationship: fields.relationship, notes: fields.notes, linkedin_url: fields.linkedin_url, kind: fields.kind, employer_id: id.nullable().optional() }),
  measure: 'none',
  async run(ctx, { id: contactId, employer_id, ...patch }) {
    await owned(ctx, contactId)
    const row: Record<string, unknown> = { ...patch }
    // the person's own choice of employer is theirs: the sync never overwrites it
    if (employer_id !== undefined) Object.assign(row, { employer_id, employer_origin: employer_id ? 'person' : null, employer_prov: employer_id ? { door: 'session' } : null })
    if (Object.keys(row).length === 0) return { id: contactId }
    const { error } = await db(ctx).from('contacts').update(row).eq('id', contactId).eq('user_id', ctx.userId)
    if (error?.code === '23505') throw new CommandRefusal(409, 'You already have someone with that address.', 'duplicate')
    if (error) throw new Error('Could not save the person.')
    return { id: contactId }
  },
})

export const peopleDelete = personCommand({
  id: 'people.delete',
  label: 'Delete person',
  input: z.strictObject({ id }),
  measure: 'none',
  async run(ctx, i) {
    const person = await owned(ctx, i.id)
    const { forgetPerson } = await import('@/lib/network/memory')
    const { count } = await db(ctx).from('messages').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).eq('contact_id', i.id)
    await forgetPerson(ctx.admin() as never, ctx.userId, i.id)
    const { error } = await db(ctx).from('contacts').delete().eq('id', i.id).eq('user_id', ctx.userId)
    if (error) throw new Error('Could not delete the person.')
    // the mail rows stay (contact_id goes null) and the sentence says so
    return { deleted: true, name: person.name, messages_kept: count ?? 0 }
  },
})

export const peopleImport = personCommand({
  id: 'people.import',
  label: 'Import contacts',
  input: z.strictObject({ rows: z.array(z.strictObject({ ...fields, name: fields.name })).min(1).max(5000) }),
  measure: 'none',
  async run(ctx, i) {
    const { data: have } = await db(ctx).from('contacts').select('email').eq('user_id', ctx.userId).not('email', 'is', null).limit(20000)
    const seen = new Set(((have ?? []) as { email: string }[]).map((r) => r.email.toLowerCase()))
    const fresh = i.rows.filter((r) => {
      if (!r.email) return true
      if (seen.has(r.email)) return false
      seen.add(r.email)
      return true
    })
    for (let n = 0; n < fresh.length; n += 500) {
      const { error } = await db(ctx).from('contacts').insert(fresh.slice(n, n + 500).map((r) => ({ user_id: ctx.userId, ...r, source: 'import', first_seen_at: new Date().toISOString() })))
      if (error) throw new Error('Could not import the contacts.')
    }
    return { added: fresh.length, skipped: i.rows.length - fresh.length }
  },
})

export const peopleMarkContacted = personCommand({
  id: 'people.mark_contacted',
  label: 'Mark contacted today',
  input: z.strictObject({ id }),
  measure: 'none',
  async run(ctx, i) {
    await owned(ctx, i.id)
    const { error } = await db(ctx).from('contacts').update({ last_contact_at: new Date().toISOString() }).eq('id', i.id).eq('user_id', ctx.userId)
    if (error) throw new Error('Could not save that.')
    return { id: i.id }
  },
})

export const peopleFind = personCommand({
  id: 'people.find',
  label: 'Find people',
  input: z.strictObject({ company_id: id, role_id: id.optional() }),
  measure: 'S18',
  kind: 'code',
  egress: 'fixed',
  async run(ctx, i) {
    const [{ sourceContactsForCompany }, { readContactProviderKeys }] = await Promise.all([import('@/lib/contacts/sources'), import('@/lib/contacts/keys')])
    const admin = ctx.admin() as never
    const keys = await readContactProviderKeys(admin, ctx.userId)
    const r = await sourceContactsForCompany({ client: admin, userId: ctx.userId, companyId: i.company_id, jobId: i.role_id ?? null, hunterKey: keys.hunter ?? null, apolloKey: keys.apollo ?? null })
    return { company: r.companyName, headline: r.search.headline, inserted: r.inserted, skippedExisting: r.skippedExisting }
  },
})

export const peopleTie = personCommand({
  id: 'people.tie',
  label: 'Tie to an application',
  input: z.strictObject({ contact_id: id, application_id: id, remove: z.boolean().optional() }),
  measure: 'T31',
  async run(ctx, i) {
    await owned(ctx, i.contact_id)
    const q = db(ctx).from('contact_applications')
    const { error } = i.remove
      ? await q.delete().eq('contact_id', i.contact_id).eq('application_id', i.application_id).eq('user_id', ctx.userId)
      : await q.upsert({ user_id: ctx.userId, contact_id: i.contact_id, application_id: i.application_id, origin: 'person' }, { onConflict: 'contact_id,application_id' })
    if (error) throw new Error('Could not change that tie.')
    return { ok: true }
  },
})

export const peopleProfile = personCommand({
  id: 'people.profile',
  label: 'Find profile',
  input: z.strictObject({ contact_id: id }),
  measure: 'S25',
  kind: 'wf',
  egress: 'fixed',
  async run(ctx, i) {
    const person = await owned(ctx, i.contact_id)
    const admin = ctx.admin() as never
    // off for everyone but the owner until S25 passes on his 20 marked contacts (13.2)
    const { flag } = await import('@/lib/network/run')
    if (!isOwner(ctx.userId) && !(await flag(admin, 'network_profiles_live', false))) throw new CommandRefusal(403, 'Cello is not finding profiles yet.', 'switched_off')
    const slots = ctx.slots ?? rpcSlotStore(ctx.admin())
    if (!(await slots.take({ userId: ctx.userId, channel: ctx.door, bucket: `people.profile:${i.contact_id}`, limit: 20, windowSeconds: 86_400 }))) {
      throw new CommandRefusal(429, 'Cello has searched for this person enough today. Try again tomorrow.', 'limit')
    }
    const { data: c } = await db(ctx).from('contact_touch').select('employer_id, agency_name').eq('contact_id', i.contact_id).maybeSingle()
    const row = c as { employer_id: string | null; agency_name: string | null } | null
    let employer = row?.agency_name ?? null
    if (row?.employer_id) employer = ((await db(ctx).from('company_directory').select('name').eq('id', row.employer_id).maybeSingle()).data as { name: string } | null)?.name ?? employer
    const { findProfile } = await import('@/lib/network/profile')
    return findProfile(admin, ctx.userId, { id: person.id, name: person.name, employer })
  },
})

export const peopleConfirmProfile = personCommand({
  id: 'people.confirm_profile',
  label: 'This is them',
  input: z.strictObject({ profile_id: id, state: z.enum(['kept', 'rejected']) }),
  measure: 'S25',
  async run(ctx, i) {
    const admin = ctx.admin()
    const { data } = await db(ctx).from('contact_profiles').select('id, contact_id, url, host').eq('id', i.profile_id).eq('user_id', ctx.userId).maybeSingle()
    const p = data as { id: string; contact_id: string; url: string; host: string } | null
    if (!p) throw new CommandRefusal(404, 'That result is gone.', 'not_found')
    if (i.state === 'kept') {
      await admin.from('contact_profiles').update({ state: 'proposed' }).eq('contact_id', p.contact_id).eq('state', 'kept')
    }
    const { error } = await admin.from('contact_profiles').update({ state: i.state, origin: 'person', prov: { door: 'session' } }).eq('id', p.id).eq('user_id', ctx.userId)
    if (error) throw new Error('Could not save that.')
    if (i.state === 'kept' && p.host.endsWith('linkedin.com')) await admin.from('contacts').update({ linkedin_url: p.url }).eq('id', p.contact_id).eq('user_id', ctx.userId).is('linkedin_url', null)
    return { ok: true }
  },
})

export const peopleMemory = personCommand({
  id: 'people.memory',
  label: 'What Cello remembers',
  input: z.strictObject({ contact_id: id.optional(), employer_id: id.optional() }),
  measure: 'S26',
  async run(ctx, i) {
    if (!i.contact_id && !i.employer_id) throw new CommandRefusal(400, 'Say whose memories to read.', 'input')
    const { recall } = await import('@/lib/network/memory')
    return { memories: await recall(ctx.admin() as never, ctx.userId, { contactId: i.contact_id, employerId: i.employer_id }) }
  },
})

export const peopleForget = personCommand({
  id: 'people.forget',
  label: 'Not right',
  input: z.strictObject({ memory_id: id }),
  measure: 'none',
  async run(ctx, i) {
    const { forget } = await import('@/lib/network/memory')
    await forget(ctx.admin() as never, ctx.userId, i.memory_id).catch(() => {
      throw new CommandRefusal(404, 'That memory is gone.', 'not_found')
    })
    return { ok: true }
  },
})

export const peopleEditMemory = personCommand({
  id: 'people.edit_memory',
  label: 'Edit memory',
  input: z.strictObject({ memory_id: id, text: text(300).min(1) }),
  measure: 'none',
  async run(ctx, i) {
    const { editMemory } = await import('@/lib/network/memory')
    await editMemory(ctx.userId, i.memory_id, i.text).catch(() => {
      throw new CommandRefusal(404, 'That memory is gone.', 'not_found')
    })
    return { ok: true }
  },
})

export const networkNudges = personCommand({
  id: 'network.nudges',
  label: 'Follow up',
  input: z.strictObject({ contact_id: id.optional() }),
  measure: 'T32',
  async run(ctx, i) {
    const { dueNudges } = await import('@/lib/network/nudges')
    const due = await dueNudges(readClient(ctx), ctx.userId)
    return { due: i.contact_id ? due.filter((d) => d.contactId === i.contact_id) : due }
  },
})

export const networkSetRule = personCommand({
  id: 'network.set_rule',
  label: 'Follow-up reminders',
  input: z.strictObject({
    contact_id: id.optional(),
    /** null returns a person to "use my default". */
    rule: z.union([z.null(), z.strictObject({ on: z.boolean().optional(), off: z.boolean().optional(), after_yours_bd: z.number().int().min(1).max(30).optional(), after_theirs_d: z.number().int().min(1).max(14).optional(), snooze_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() })]),
  }),
  measure: 'T32',
  async run(ctx, i) {
    if (i.contact_id) await owned(ctx, i.contact_id)
    else if (i.rule === null) throw new CommandRefusal(400, 'Say which person returns to your default.', 'input')
    const { error } = await ctx.admin().rpc('set_network_rule', { p_user: ctx.userId, p_contact: i.contact_id ?? null, p_rule: i.rule })
    if (error) throw new CommandRefusal(400, error.message.slice(0, 200), 'input')
    return { ok: true }
  },
})

export const peopleCommands: AnyCommand[] = [
  peopleList,
  peopleGet,
  peopleAdd,
  peopleEdit,
  peopleDelete,
  peopleImport,
  peopleMarkContacted,
  peopleFind,
  peopleTie,
  peopleProfile,
  peopleConfirmProfile,
  peopleMemory,
  peopleForget,
  peopleEditMemory,
  networkNudges,
  networkSetRule,
]
