// research, people and search_knowledge: finding out about companies and people, and what is already known.

import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'
import { sourceContactsForCompany } from '@/lib/contacts/sources'
import { readContactProviderKeys } from '@/lib/contacts/keys'
import { resolveCompany } from '@/lib/entities/companies'
import { getMemoryStore } from '@/lib/memory/mem0-store'
import { doSearchKb, loadOwnedCompany, researchOneCompany, type ResearchCompanyOutcome } from '@/lib/harness/copilot-tools'
import { createArtifact } from '../artifacts'
import { fanOut, PartialValue, summarizeCounts, type BranchContext } from '../fanout'
import type { AgentContext } from '../context'
import type { ResearcherResult } from '../subagents/researcher'
import { branchRecorder, finishTask, retitleTask, startTask, type TaskScope } from '../tasks'
import { clip, defineTool, keyFor, readFields, toolFix, writeFields, type CelloTool } from './common'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One subject's result, as the tool returns it. */
interface SubjectResult {
  subject: string
  summary: string | null
  artifact_id: string | null
  sponsors_visa?: string | null
  sources: { title?: string | null; url: string }[]
  note?: string
}

async function companyIdFor(ctx: AgentContext, subject: string): Promise<string | null> {
  if (UUID.test(subject)) {
    const owned = await loadOwnedCompany(ctx, subject)
    return 'error' in owned ? null : subject
  }
  const found = await resolveCompany(ctx.admin, ctx.userId, { name: subject })
  return found?.id ?? null
}

/** The saved company record, as the dossier artifact the person can open. */
async function dossierFromRecord(ctx: AgentContext, companyId: string, outcome: Extract<ResearchCompanyOutcome, { status: 'researched' }>, key: string): Promise<SubjectResult> {
  const { data } = await ctx.admin
    .from('company_dossiers')
    .select('id, summary, sponsors_visa, sources')
    .eq('company_id', companyId)
    .eq('user_id', ctx.userId)
    .maybeSingle()
  const row = data as { id: string; summary: string | null; sponsors_visa: string | null; sources: { title?: string; url: string }[] | null } | null
  const sources = (row?.sources ?? []).slice(0, 12)
  const ref = await createArtifact(ctx.admin, {
    userId: ctx.userId,
    type: 'dossier',
    title: `Research on ${outcome.company}`,
    content: { company: outcome.company, summary: row?.summary ?? null, sponsors_visa: row?.sponsors_visa ?? null, sources, dossier_id: row?.id ?? null, partial: outcome.partial ?? false },
    author: 'cello',
    companyId,
    conversationId: ctx.conversationId,
    idempotencyKey: key,
    traceId: ctx.traceId,
  })
  return {
    subject: outcome.company,
    summary: row?.summary ?? null,
    artifact_id: ref.id,
    sponsors_visa: row?.sponsors_visa ?? null,
    sources,
    ...(outcome.partial ? { note: outcome.reason } : {}),
  }
}

async function researchOne(
  ctx: AgentContext,
  subject: string,
  kind: 'company' | 'person' | 'topic',
  depth: 'quick' | 'deep',
  branch: BranchContext,
  key: string,
  config?: RunnableConfig
): Promise<SubjectResult | PartialValue<SubjectResult>> {
  if (kind === 'company' && depth === 'quick') {
    const companyId = await companyIdFor(ctx, subject)
    if (companyId) {
      const outcome = await researchOneCompany({ ...ctx, signal: branch.signal }, companyId, branch.signal)
      if (outcome.status === 'error') throw new Error(outcome.reason)
      return dossierFromRecord(ctx, companyId, outcome, key)
    }
    // A company that is not tracked has no saved record to read: the Researcher looks it up on the web.
  }
  // The Researcher is a loop with its own model and step cap. It is loaded here, not at the top of the file, because it imports these tools.
  const { runResearcher } = await import('../run')
  const res: ResearcherResult = await runResearcher(ctx, { subject, kind }, { signal: branch.signal, maxSteps: branch.caps.steps, config })
  if (!res.enough_information) {
    const none: SubjectResult = { subject, summary: null, artifact_id: null, sources: res.sources, note: 'Not enough public information to say anything reliable.' }
    return res.hit_step_limit ? new PartialValue('steps', none) : none
  }
  const ref = await createArtifact(ctx.admin, {
    userId: ctx.userId,
    type: 'dossier',
    title: `Research on ${subject}`,
    content: { company: subject, summary: res.summary, sources: res.sources, partial: res.hit_step_limit },
    author: 'cello',
    conversationId: ctx.conversationId,
    idempotencyKey: key,
    traceId: ctx.traceId,
  })
  const value: SubjectResult = { subject, summary: res.summary, artifact_id: ref.id, sources: res.sources }
  return res.hit_step_limit ? new PartialValue('steps', value) : value
}

export const research = defineTool({
  name: 'research',
  description:
    'Research companies, people or topics and save a cited dossier for each. subjects is 1 to 8 names, run a few at a time. kind is company, person or topic. ' +
    'depth quick uses the saved company record and public sources. depth deep sends a researcher to read and cite the web, which is slower. ' +
    'Always cited. It says so when the public sources are too thin to be reliable. Use it for "research these companies" and "what is it like to work at X". ' +
    'To find who to contact use people.',
  schema: z.object({
    subjects: z.array(z.string().min(1).max(120)).min(1).max(8).describe('Names to research, or ids of tracked companies.'),
    kind: z.enum(['company', 'person', 'topic']).default('company').describe('What the subjects are.'),
    depth: z.enum(['quick', 'deep']).default('quick').describe('quick reads saved records and public sources. deep sends a researcher to read the web, which is slower.'),
    response_format: readFields.response_format,
    limit: readFields.limit,
    ...writeFields,
  }),
  kind: 'write',
  untrusted: true,
  mcp: true,
  async handler(ctx, a, meta) {
    const subjects = [...new Set(a.subjects.map((s) => s.trim()).filter(Boolean))].slice(0, 8)
    const scope: TaskScope = { admin: ctx.admin, userId: ctx.userId, threadId: ctx.threadId, conversationId: ctx.conversationId, scheduledTaskId: ctx.scheduledTaskId, traceId: ctx.traceId }
    const noun = a.kind === 'company' ? { one: 'company', many: 'companies' } : a.kind === 'person' ? { one: 'person', many: 'people' } : { one: 'topic', many: 'topics' }
    const parent = await startTask(scope, {
      agent: 'researcher',
      title: `Researching ${subjects.length} ${subjects.length === 1 ? noun.one : noun.many}`,
      parentId: ctx.rootTaskId ?? null,
    })
    const base = keyFor(ctx, meta, a.idempotency_key)
    const out = await fanOut<string, SubjectResult>({
      items: subjects,
      // A quick company read is one call; a deep one is a loop of up to 8 steps.
      caps: { steps: 8, ms: a.depth === 'deep' ? 150_000 : 90_000, tokens: a.depth === 'deep' ? 40_000 : 15_000 },
      deadlineAt: ctx.deadlineAt,
      signal: meta.config?.signal ?? ctx.signal,
      onBranch: branchRecorder<string, SubjectResult>(scope, parent, 'researcher', (s) => `Researching ${s}`, (r) => clip(r.value?.summary, 300) ?? undefined),
      worker: (subject, branch) => researchOne(ctx, subject, a.kind, a.depth, branch, `${base}:${branch.index}`, meta.config),
    })
    await retitleTask(ctx.admin, parent, summarizeCounts('Researching', noun, subjects.length, out.counts))
    await finishTask(ctx.admin, parent, {
      status: out.counts.failed === subjects.length ? 'failed' : out.counts.partial + out.counts.failed > 0 ? 'partial' : 'done',
      partialReason: out.results.find((r) => r.status === 'partial')?.reason ?? null,
      artifactIds: out.results.map((r) => r.value?.artifact_id).filter((id): id is string => Boolean(id)),
    })
    const detailed = a.response_format === 'detailed'
    return {
      requested: subjects.length,
      ok: out.counts.ok,
      partial: out.counts.partial,
      failed: out.counts.failed,
      results: out.results.map((r, i) => ({
        subject: subjects[i],
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.status === 'failed' ? { error: r.error } : {}),
        ...(r.value
          ? {
              summary: clip(r.value.summary, detailed ? 1500 : 300),
              artifact_id: r.value.artifact_id,
              sources: detailed ? r.value.sources.slice(0, a.limit) : r.value.sources.length,
              ...(r.value.sponsors_visa ? { sponsors_visa: r.value.sponsors_visa } : {}),
              ...(r.value.note ? { note: r.value.note } : {}),
            }
          : {}),
      })),
      ...(out.counts.partial + out.counts.failed > 0 ? { note: 'Some subjects did not finish. Say which, and why, when you report.' } : {}),
    }
  },
}) satisfies CelloTool

// --- people -------------------------------------------------------------------------

type ContactRow = {
  id: string
  name: string
  title: string | null
  email: string | null
  verified: boolean
  source: string | null
  confidence: number | null
  basis: string | null
}

const emailStatus = (c: ContactRow): 'verified' | 'inferred' | 'none' => (!c.email ? 'none' : c.verified ? 'verified' : 'inferred')

async function listCompanyContacts(ctx: AgentContext, companyId: string): Promise<ContactRow[]> {
  const { data } = await ctx.admin
    .from('contacts')
    .select('id, name, title, email, verified, source, confidence, basis')
    .eq('user_id', ctx.userId)
    .eq('company_id', companyId)
    .order('verified', { ascending: false })
  return (data as ContactRow[] | null) ?? []
}

export const people = defineTool({
  name: 'people',
  description:
    'List the people at a company the person could contact, each with an email status of verified, inferred or none. Pass company_id from find_roles or get_role. ' +
    'Set find_new to true to look for more people when the list is short. Never sends anything. Use it before writing to someone, to choose a contact_id.',
  schema: z.object({
    company_id: z.string().min(1).describe('The company id from find_roles or get_role.'),
    role: z.string().max(80).optional().describe('Only people whose title contains this text, for example "recruiter".'),
    find_new: z.boolean().default(false).describe('True to look for more people now. This saves what it finds.'),
    ...readFields,
  }),
  kind: 'read',
  untrusted: true,
  mcp: true,
  async handler(ctx, a, meta) {
    const owned = await loadOwnedCompany(ctx, a.company_id)
    if ('error' in owned) return toolFix(owned.error, 'Call find_roles and use a company_id it returned.')
    let rows = await listCompanyContacts(ctx, a.company_id)
    let lookedUp = false
    if ((a.find_new && !ctx.readOnly) || (rows.length === 0 && !ctx.readOnly)) {
      lookedUp = true
      try {
        const keys = await readContactProviderKeys(ctx.admin, ctx.userId)
        await sourceContactsForCompany({ client: ctx.admin, userId: ctx.userId, companyId: a.company_id, jobId: null, hunterKey: keys.hunter, apolloKey: keys.apollo, limit: 10, signal: meta.config?.signal ?? ctx.signal })
        rows = await listCompanyContacts(ctx, a.company_id)
      } catch {
        // The saved list is still useful; the note below says the lookup did not run.
      }
    }
    const before = rows.length
    if (a.role) rows = rows.filter((c) => (c.title ?? '').toLowerCase().includes(a.role!.toLowerCase()))
    const detailed = a.response_format === 'detailed'
    return {
      company: owned.company.name,
      count: Math.min(rows.length, a.limit),
      people: rows.slice(0, a.limit).map((c) => ({
        id: c.id,
        name: c.name,
        title: c.title,
        email_status: emailStatus(c),
        ...(detailed ? { email: c.email, source: c.source, confidence: c.confidence, basis: c.basis } : {}),
      })),
      ...(rows.length === 0
        ? {
            note: lookedUp
              ? 'No one found yet. Say so, and do not guess a name or an address.'
              : before > 0
                ? `No saved contact has a title containing "${a.role}". Try without role, or call people again with find_new true.`
                : 'No one saved for this company. Call people again with find_new true.',
          }
        : {}),
    }
  },
}) satisfies CelloTool

// --- search_knowledge ----------------------------------------------------------------

export const searchKnowledge = defineTool({
  name: 'search_knowledge',
  description:
    'Search the person\'s saved notes, research and memories. Use it before researching something again, and for "what did we find about X". ' +
    'Returns short excerpts with where each came from.',
  schema: z.object({
    query: z.string().min(2).max(200).describe('What to look for, in plain words.'),
    ...readFields,
  }),
  kind: 'read',
  untrusted: true,
  mcp: true,
  async handler(ctx, a) {
    const detailed = a.response_format === 'detailed'
    const kb = (await doSearchKb(ctx, { query: a.query, limit: a.limit })) as { hits?: { title: string; url: string | null; content: string }[]; error?: string }
    if (kb.error) return toolFix(kb.error, 'Try different words.')
    const memories = await getMemoryStore()
      .search(ctx.userId, a.query, { limit: Math.min(a.limit, 5) })
      .catch(() => [])
    return {
      count: (kb.hits?.length ?? 0) + memories.length,
      notes: (kb.hits ?? []).map((h) => ({ source: h.title, url: h.url, excerpt: clip(h.content, detailed ? 800 : 300) })),
      memories: memories.map((m) => ({ memory: clip(m.memory, detailed ? 600 : 240) })),
      ...((kb.hits?.length ?? 0) + memories.length === 0 ? { note: 'Nothing saved matches. It may need research.' } : {}),
    }
  },
}) satisfies CelloTool
