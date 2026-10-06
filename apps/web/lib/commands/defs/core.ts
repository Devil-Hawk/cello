// The commands K10 owns: the sends, autonomy, the person's record and search,
// activity, the last check, onboarding and account deletion. Each wraps code that
// already exists; none reaches a model. Commands over data other lanes create
// (applications, learned, people, chat) live in those lanes' defs files.

import { z } from 'zod'
import { defineCommand, CommandRefusal, type AnyCommand, type CommandContext } from '../define'
import { codeText, untrustedJson, untrustedText } from '../text'
import { readClient } from '../scope'
import { OWNED_TABLES } from '../owned'

// ---------------------------------------------------------------------------
// conversations.send: the one way a message or an application leaves
// ---------------------------------------------------------------------------

export const conversationsSend = defineCommand({
  id: 'conversations.send',
  label: 'Approve and send',
  input: z.strictObject({
    via: z.enum(['outreach', 'draft']),
    outreach_id: z.string().max(100).optional(),
    approve: z.boolean().optional(),
    draft_id: z.string().max(100).optional(),
  }),
  output: z.object({ status: z.number().int(), body: untrustedJson() }),
  callers: ['session'],
  kind: 'code',
  sends: true,
  egress: 'gmail',
  measure: 'S6',
  async run(ctx, input) {
    if (input.via === 'outreach') {
      if (!input.outreach_id) return { status: 400, body: { error: 'id is required' } }
      const { sendOutreach } = await import('../send/outreach')
      return sendOutreach(ctx, { id: input.outreach_id, approve: input.approve === true })
    }
    if (!input.draft_id) return { status: 400, body: { error: 'draftId is required' } }
    const { approveDraft } = await import('../send/draft')
    return approveDraft(ctx, { draftId: input.draft_id })
  },
})

// ---------------------------------------------------------------------------
// autonomy.update: set_autonomy() is the only writer of preferences.pipeline
// ---------------------------------------------------------------------------

export const autonomyUpdate = defineCommand({
  id: 'autonomy.update',
  label: 'Send for me',
  input: z.strictObject({ pipeline: z.record(z.string().max(60), z.unknown()) }),
  output: z.object({ saved: z.boolean() }),
  callers: ['session'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T14',
  async run(ctx, input) {
    if (!ctx.supabase) throw new CommandRefusal(403, 'This action needs the person signed in.', 'proof')
    if (Object.keys(input.pipeline).length > 50) throw new CommandRefusal(400, 'That is too many settings.', 'input')
    const { error } = await ctx.supabase.rpc('set_autonomy', { p_pipeline: input.pipeline })
    if (error) {
      if (error.code === '42501') throw new CommandRefusal(403, 'This workspace cannot change that setting.', 'guard')
      throw new Error('Could not save that setting.')
    }
    return { saved: true }
  },
})

// ---------------------------------------------------------------------------
// profile.get and search.get: the person's record and what they look for
// ---------------------------------------------------------------------------

const fieldList = z.array(z.object({ key: codeText(60), value: untrustedText(20_000) }))

async function readProfile(ctx: CommandContext) {
  const { data, error } = await ctx.admin().from('profiles').select('full_name, resume_text, preferences').eq('id', ctx.userId).maybeSingle()
  if (error) throw new Error('Could not read the profile.')
  return (data ?? {}) as { full_name?: string | null; resume_text?: string | null; preferences?: Record<string, unknown> | null }
}

export const profileGet = defineCommand({
  id: 'profile.get',
  label: 'Your profile',
  input: z.strictObject({ section: z.enum(['basics', 'resume', 'application_identity']).default('basics') }),
  output: z.object({ section: codeText(30), withheld: z.boolean(), fields: fieldList }),
  callers: ['session', 'chat', 'assistant'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T12',
  async run(ctx, input) {
    // Sensitive answers are for the person's own forms, never for a model or a host.
    if (input.section === 'application_identity' && ctx.door !== 'session') {
      return { section: input.section, withheld: true, fields: [] }
    }
    const profile = await readProfile(ctx)
    if (input.section === 'resume') {
      const text = profile.resume_text ?? ''
      return { section: input.section, withheld: false, fields: [{ key: 'resume_text', value: text.slice(0, 20_000) }] }
    }
    if (input.section === 'application_identity') {
      const identity = (profile.preferences?.applicationIdentity ?? {}) as Record<string, unknown>
      const fields = Object.entries(identity)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([key, v]) => ({ key: key.slice(0, 60), value: String(v).slice(0, 2_000) }))
      return { section: input.section, withheld: false, fields }
    }
    return {
      section: input.section,
      withheld: false,
      fields: [
        { key: 'full_name', value: profile.full_name ?? '' },
        { key: 'has_resume', value: profile.resume_text ? 'yes' : 'no' },
        { key: 'onboarded', value: profile.preferences?.onboardedAt ? 'yes' : 'no' },
      ],
    }
  },
})

export const searchGet = defineCommand({
  id: 'search.get',
  label: 'Your search',
  input: z.strictObject({}),
  output: z.object({ configured: z.boolean(), fields: fieldList }),
  callers: ['session', 'chat', 'assistant'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T12',
  async run(ctx) {
    const { resolveTargeting, isTargetingConfigured } = await import('@/lib/targeting')
    const profile = await readProfile(ctx)
    const targeting = resolveTargeting(profile.preferences?.targeting)
    const fields = Object.entries(targeting).map(([key, value]) => ({
      key,
      value: Array.isArray(value) ? value.join(', ') : value === null ? '' : String(value),
    }))
    return { configured: isTargetingConfigured(targeting), fields }
  },
})

// ---------------------------------------------------------------------------
// activity.get: what model work ran, by step and door, from the spend ledger
// ---------------------------------------------------------------------------

export const activityGet = defineCommand({
  id: 'activity.get',
  label: 'Activity',
  input: z.strictObject({ days: z.number().int().min(1).max(90).default(7) }),
  output: z.object({
    days: z.number().int(),
    rows: z.array(
      z.object({
        step: codeText(80),
        door: codeText(20),
        rung: codeText(4),
        count: z.number().int(),
        usd: z.number(),
      })
    ),
  }),
  callers: ['session', 'chat', 'assistant'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'P5',
  async run(ctx, input) {
    const since = new Date(Date.now() - input.days * 86_400_000).toISOString()
    const { data, error } = await ctx
      .admin()
      .from('llm_spend')
      .select('step, door, rung, estimate_usd, actual_usd')
      .eq('user_id', ctx.userId)
      .gte('created_at', since)
      .limit(5000)
    if (error) throw new Error('Could not read activity.')
    const groups = new Map<string, { step: string; door: string; rung: string; count: number; usd: number }>()
    for (const r of (data ?? []) as { step: string | null; door: string | null; rung: string | null; estimate_usd: number | null; actual_usd: number | null }[]) {
      const step = r.step ?? 'unknown'
      const door = r.door ?? 'unknown'
      const rung = r.rung ?? 'R4'
      const key = `${step}|${door}|${rung}`
      const g = groups.get(key) ?? { step, door, rung, count: 0, usd: 0 }
      g.count += 1
      g.usd += Number(r.actual_usd ?? r.estimate_usd ?? 0)
      groups.set(key, g)
    }
    const rows = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 200)
    return { days: input.days, rows }
  },
})

// ---------------------------------------------------------------------------
// checks.status: when roles were last checked and what could not be read
// ---------------------------------------------------------------------------

export const checksStatus = defineCommand({
  id: 'checks.status',
  label: 'Last check',
  input: z.strictObject({}),
  output: z.object({
    state: codeText(20),
    started_at: codeText(40).nullable(),
    finished_at: codeText(40).nullable(),
    next_check_at: codeText(40),
    companies_checked: z.number().int(),
    companies_total: z.number().int(),
    jobs_new: z.number().int(),
    failed: z.array(z.object({ company: untrustedText(200), reason: codeText(300) })),
  }),
  callers: ['session', 'chat', 'assistant'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T5',
  async run(ctx) {
    const { readFindNewRoles } = await import('@/lib/ingest/status')
    const s = await readFindNewRoles(readClient(ctx))
    return {
      state: s.state,
      started_at: s.startedAt,
      finished_at: s.finishedAt,
      next_check_at: s.nextCheckAt,
      companies_checked: s.companiesChecked,
      companies_total: s.companiesTotal,
      jobs_new: s.jobsNew,
      failed: s.failed.map((f) => ({ company: f.companyName.slice(0, 200), reason: f.text })),
    }
  },
})

// ---------------------------------------------------------------------------
// onboarding.finish: the Welcome page's finish write
// ---------------------------------------------------------------------------

export const onboardingFinish = defineCommand({
  id: 'onboarding.finish',
  label: 'Finish setup',
  input: z.strictObject({ match_threshold: z.number().min(0).max(100).optional() }),
  output: z.object({ onboarded: z.boolean() }),
  callers: ['session'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'P6',
  async run(ctx, input) {
    if (!ctx.supabase) throw new CommandRefusal(403, 'This action needs the person signed in.', 'proof')
    const { fetchClientSafePreferences, markOnboarded } = await import('@/lib/preferences/client-safe')
    // The write always sets a threshold, so a finish that names none keeps the one in force.
    const current = (await fetchClientSafePreferences(ctx.supabase))?.matchThreshold
    const threshold = input.match_threshold ?? (typeof current === 'number' ? current : 70)
    const error = await markOnboarded(ctx.supabase, threshold)
    if (error) throw new Error('Could not finish setup.')
    return { onboarded: true }
  },
})

// ---------------------------------------------------------------------------
// models.get, settings.models, models.test: Settings > Models (blueprint 11.1)
// ---------------------------------------------------------------------------

export const modelsGet = defineCommand({
  id: 'models.get',
  label: 'Models',
  input: z.strictObject({}),
  output: z.object({
    rungs: z.array(z.object({ rung: codeText(4), state: z.enum(['ready', 'not_set_up']) })),
    ceiling: codeText(4),
    order: z.array(codeText(4)),
    creditBought: z.boolean(),
    freeToday: z.number().int(),
    freeLimit: z.number().int(),
    resetsAt: codeText(40),
  }),
  callers: ['session'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'P5',
  async run(ctx) {
    const { readModelSettings } = await import('@/lib/models/settings')
    return readModelSettings(ctx.admin(), ctx.userId)
  },
})

export const settingsModels = defineCommand({
  id: 'settings.models',
  label: 'Highest model Cello may use',
  input: z.strictObject({
    ceiling: z.enum(['R0', 'R1', 'R2', 'R3', 'R4']).optional(),
    order: z.array(z.enum(['R1', 'R2', 'R3', 'R4'])).max(4).optional(),
    creditBought: z.boolean().optional(),
  }),
  output: z.object({ saved: z.boolean() }),
  callers: ['session'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'P5',
  guard: (ctx) => demoRefusal(ctx, 'Demo workspaces cannot change this.'),
  async run(ctx, input) {
    const db = ctx.supabase
    if (!db) throw new CommandRefusal(403, 'This action needs the person signed in.', 'proof')
    if (input.ceiling === undefined && input.order === undefined && input.creditBought === undefined) {
      throw new CommandRefusal(400, 'Nothing to change.', 'input')
    }
    const readPreferences = async () => {
      const { data, error } = await db.from('profiles').select('preferences').eq('id', ctx.userId).single()
      if (error) throw new Error('Could not read the settings.')
      return ((data as { preferences?: Record<string, unknown> | null } | null)?.preferences ?? {}) as Record<string, unknown>
    }
    // credit_bought lives in preferences.pipeline, which only set_autonomy() writes.
    if (input.creditBought !== undefined) {
      const pipeline = ((await readPreferences()).pipeline ?? {}) as Record<string, unknown>
      const { error } = await db.rpc('set_autonomy', { p_pipeline: { ...pipeline, credit_bought: input.creditBought } })
      if (error) {
        if (error.code === '42501') throw new CommandRefusal(403, 'This workspace cannot change that setting.', 'guard')
        throw new Error('Could not save that setting.')
      }
    }
    if (input.ceiling !== undefined || input.order !== undefined) {
      const preferences = await readPreferences()
      const models = { ...((preferences.models ?? {}) as Record<string, unknown>), ...(input.ceiling ? { ceiling: input.ceiling } : {}), ...(input.order ? { order: input.order } : {}) }
      const { error } = await db.from('profiles').update({ preferences: { ...preferences, models } }).eq('id', ctx.userId)
      if (error) throw new Error('Could not save that setting.')
    }
    return { saved: true }
  },
})

export const modelsTest = defineCommand({
  id: 'models.test',
  label: 'Test the models',
  input: z.strictObject({}),
  output: z.object({ results: z.array(z.object({ rung: codeText(4), ok: z.boolean(), sentence: untrustedText(300) })) }),
  callers: ['session'],
  kind: 'step',
  sends: false,
  egress: 'fixed',
  measure: 'P5',
  async run(ctx) {
    const { testRungs } = await import('@/lib/models/settings')
    return { results: await testRungs(ctx.admin(), ctx.userId, ctx.signal) }
  },
})

// ---------------------------------------------------------------------------
// settings.delete_account: every owned table, then the sign-in itself
// ---------------------------------------------------------------------------

/** The refusal sentence for a demo workspace, or null for a real account. */
async function demoRefusal(ctx: CommandContext, sentence: string): Promise<string | null> {
  const { readProfileForDemoGuards } = await import('@/lib/harness/keys')
  const { isDemoProfile } = await import('@/lib/access/guardrails')
  const { row, error } = await readProfileForDemoGuards(ctx.admin(), ctx.userId)
  if (error || !row) return "We couldn't verify this account."
  return isDemoProfile({ is_demo: row.is_demo ?? null, demo_expires_at: row.demo_expires_at ?? null }) ? sentence : null
}

export const deleteAccount = defineCommand({
  id: 'settings.delete_account',
  label: 'Delete account',
  input: z.strictObject({ confirm: z.literal('delete my account') }),
  output: z.object({ tables_cleared: z.number().int(), deleted: z.boolean() }),
  callers: ['session'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'none',
  guard: (ctx) => demoRefusal(ctx, 'Demo workspaces cannot delete an account.'),
  async run(ctx) {
    const admin = ctx.admin()
    let cleared = 0
    // Best effort and in list order. A row a foreign key holds back is removed by
    // the cascade when the sign-in goes, which is what makes deleteUser the
    // authoritative step.
    for (const { table, column } of OWNED_TABLES) {
      const { error } = await admin.from(table).delete().eq(column ?? 'user_id', ctx.userId)
      if (!error) cleared += 1
    }
    try {
      const { getMemoryStore } = await import('@/lib/memory/mem0-store')
      await getMemoryStore().deleteAll(ctx.userId)
    } catch {
      /* memories are an index over rows that are already gone */
    }
    const { error } = await admin.auth.admin.deleteUser(ctx.userId)
    if (error) throw new Error('Could not delete the account.')
    return { tables_cleared: cleared, deleted: true }
  },
})

export const coreCommands: AnyCommand[] = [
  conversationsSend,
  autonomyUpdate,
  profileGet,
  searchGet,
  activityGet,
  checksStatus,
  onboardingFinish,
  modelsGet,
  settingsModels,
  modelsTest,
  deleteAccount,
]
