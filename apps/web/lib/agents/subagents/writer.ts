// The Writer: one document, one chain, one author.
//
//   gather -> draft -> review -> (revise once) -> save
//
// A document is never split across agents. The model calls inside are the
// existing modules (the resume optimizer, the cover letter tailor, the outreach
// drafter), so their prompts and honesty rules stay where they are owned; this
// graph adds the order, the Reviewer and the saving. The Writer sees only the
// person's own record plus fields already extracted from the role, never the raw
// posting text beyond what those modules frame as data, and it never sends:
// a finished draft is an artifact, and sending is an approval the person clicks.

import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph'
import type { CompiledSubAgent } from 'deepagents'
import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'
import { cv_tailor } from '@/lib/harness/agents/cv_tailor'
import { optimizeResume } from '@/lib/harness/agents/resume_optimizer'
import { generateOutreachDraft } from '@/lib/harness/agents/outreach'
import { highlightsFrom, loadOwnedJob, loadResume, makeRunner } from '@/lib/harness/copilot-tools'
import { buildOutreachContext } from '@/lib/context/assemble'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import { frameJobText } from '@/lib/security/job-text'
import type { LlmRunner, StepContext } from '@/lib/harness/types'
import type { AgentContext } from '../context'
import { addVersion, createArtifact, findArtifactByKey, getArtifact, type ArtifactType } from '../artifacts'
import { ARTIFACT_WRITE_TYPES } from '../backends'
import { activity, invokeSpecialist, lastHumanText, parseBrief, summaryMessage, type Fix } from './common'
import { reviewDraft, type DraftKind, type JudgeDeps, type ReviewResult } from './review'

export const WriterBriefSchema = z.object({
  type: z.enum(['resume', 'cover_letter', 'outreach_email', 'follow_up']),
  job_id: z.string().min(1).optional(),
  contact_id: z.string().min(1).optional(),
  /** What the person asked for, or what to change when revising. */
  instructions: z.string().max(600).optional(),
  /** Revise this artifact instead of writing a new one. */
  artifact_id: z.string().min(1).optional(),
  idempotency_key: z.string().max(160).optional(),
})
export type WriterBrief = z.infer<typeof WriterBriefSchema>

export const WRITER_BRIEF_SHAPE = '{"type":"cover_letter","job_id":"<id from find_roles>","contact_id":"<optional>","instructions":"<optional>"}'

export interface WriterResult {
  status: 'ok' | 'needs_attention' | 'failed'
  artifact_id?: string
  version?: number
  type?: ArtifactType
  title?: string
  /** The first lines of the draft, so the answer can quote it without a second read. */
  preview?: string
  review?: { passed: boolean; issues: string[]; checks: ReviewResult['checks']; judge: ReviewResult['judge'] }
  error?: string
  fix?: string
  note?: string
}

export interface WriterDeps {
  ctx: AgentContext
  /** Test seam: a model runner instead of callLlm. */
  llm?: LlmRunner
  judge?: JudgeDeps['judge']
}

interface Facts {
  resumeText: string
  userName: string
  job: { id: string; title: string | null; description: string | null; company: string; companyId: string | null; highlights: string[] } | null
  contact: { id: string; name: string | null; title: string | null; email: string | null } | null
  previous: { text: string; version: number } | null
}

interface Draft {
  /** The body that is reviewed and saved. */
  text: string
  subject?: string
  content: Record<string, unknown>
  title: string
  artifactType: ArtifactType
}

const WriterState = Annotation.Root({
  ...MessagesAnnotation.spec,
  brief: Annotation<WriterBrief | null>(),
  facts: Annotation<Facts | null>(),
  draft: Annotation<Draft | null>(),
  review: Annotation<ReviewResult | null>(),
  attempts: Annotation<number>(),
  /** Issues the last draft was sent back with. */
  corrective: Annotation<string | null>(),
  result: Annotation<WriterResult | null>(),
})
type State = typeof WriterState.State

const artifactTypeOf = (type: WriterBrief['type']): ArtifactType => (type === 'follow_up' ? 'outreach_email' : type)

function fail(f: Fix): WriterResult {
  return { status: 'failed', error: f.error, fix: f.fix }
}

export function buildWriterGraph(deps: WriterDeps) {
  const { ctx } = deps
  const runner = (config: RunnableConfig | undefined, name: string): LlmRunner =>
    deps.llm ?? makeRunner(ctx, config?.signal ?? ctx.signal, name)

  // --- intake: the brief arrives structured, or as text from the task tool ----------

  async function intake(state: State) {
    if (state.brief) return {}
    const parsed = parseBrief(WriterBriefSchema, lastHumanText(state.messages), WRITER_BRIEF_SHAPE)
    if (!parsed.ok || !parsed.brief) return { result: fail({ error: parsed.error ?? 'The brief was not usable.', fix: `Delegate again with a JSON brief like ${WRITER_BRIEF_SHAPE}.` }) }
    return { brief: parsed.brief }
  }

  // --- gather (code, no model) --------------------------------------------------------

  async function gather(state: State, config: RunnableConfig) {
    const brief = state.brief!
    if (!canRunLlm(ctx.apiKeys)) return { result: fail({ error: missingOpenRouterMessage(ctx.apiKeys), fix: 'Tell the person to add an OpenRouter key in Settings.' }) }

    // A retried call with the same key returns what it already made.
    if (brief.idempotency_key) {
      const existing = await findArtifactByKey(ctx.admin, ctx.userId, brief.idempotency_key)
      if (existing) {
        const got = await getArtifact(ctx.admin, ctx.userId, existing.id)
        return {
          result: {
            status: 'ok' as const,
            artifact_id: existing.id,
            version: existing.current_version,
            type: existing.type,
            title: existing.title,
            preview: got?.version.content_text.slice(0, 500),
            note: 'Already written for this request.',
          },
        }
      }
    }
    activity(config, 'Reading your resume and the role')

    const resumeText = await loadResume(ctx)
    if (!resumeText) return { result: fail({ error: 'There is no resume on file.', fix: 'Ask the person to upload a resume in Settings first.' }) }

    let previous: Facts['previous'] = null
    let type = brief.type
    let jobId = brief.job_id
    let contactId = brief.contact_id
    if (brief.artifact_id) {
      const got = await getArtifact(ctx.admin, ctx.userId, brief.artifact_id)
      if (!got) return { result: fail({ error: `No artifact with id ${brief.artifact_id}.`, fix: 'Use an id returned by create_artifact or listed under /artifacts.' }) }
      if (!ARTIFACT_WRITE_TYPES.writer.includes(got.artifact.type)) return { result: fail({ error: `The writer does not revise a ${got.artifact.type.replace('_', ' ')}.`, fix: 'Revise only resumes, cover letters and outreach emails.' }) }
      previous = { text: got.version.content_text, version: got.version.version }
      type = got.artifact.type === 'outreach_email' && brief.type === 'follow_up' ? 'follow_up' : (got.artifact.type as WriterBrief['type'])
      jobId = jobId ?? got.artifact.job_id ?? undefined
      contactId = contactId ?? got.artifact.contact_id ?? undefined
    }

    if ((type === 'resume' || type === 'cover_letter') && !jobId) {
      return { result: fail({ error: `A ${type.replace('_', ' ')} is written for one role and no job_id was given.`, fix: 'Call find_roles, then pass the id of the role.' }) }
    }
    if ((type === 'outreach_email' || type === 'follow_up') && !jobId && !contactId) {
      return { result: fail({ error: 'An outreach email needs a role or a contact.', fix: 'Pass job_id, contact_id, or both. Use people() to find a contact.' }) }
    }

    let job: Facts['job'] = null
    if (jobId) {
      const found = await loadOwnedJob(ctx, jobId, 'id, title, description, company_id, match_details')
      if ('error' in found) return { result: fail({ error: found.error, fix: 'Call find_roles and use an id it returned.' }) }
      job = {
        id: found.job.id,
        title: found.job.title,
        description: found.job.description ?? null,
        company: found.companyName,
        companyId: found.job.company_id,
        highlights: highlightsFrom(found.job.match_details),
      }
    }

    let contact: Facts['contact'] = null
    if (contactId) {
      const { data } = await ctx.admin.from('contacts').select('id, name, title, email').eq('id', contactId).eq('user_id', ctx.userId).maybeSingle()
      if (!data) return { result: fail({ error: `No contact with id ${contactId}.`, fix: 'Call people() and use a contact_id it returned.' }) }
      contact = data as Facts['contact']
    }

    const { data: profile } = await ctx.admin.from('profiles').select('full_name').eq('id', ctx.userId).single()
    const userName = String((profile?.full_name as string | null) ?? '').trim() || ctx.userEmail.split('@')[0] || 'Me'
    return { facts: { resumeText, userName, job, contact, previous }, brief: { ...brief, type } }
  }

  // --- draft (a model, through the existing module for this document) ------------------

  async function draft(state: State, config: RunnableConfig) {
    const { brief, facts } = state
    if (!brief || !facts) return {}
    const attempts = (state.attempts ?? 0) + 1
    const instructions = [state.corrective, brief.instructions, facts.previous && brief.artifact_id ? `Revise this earlier version:\n${facts.previous.text.slice(0, 6000)}` : null]
      .filter(Boolean)
      .join('\n\n') || null
    activity(config, brief.type === 'resume' ? 'Tailoring your resume' : brief.type === 'cover_letter' ? 'Writing the cover letter' : 'Writing the email')
    const llm = runner(config, `write-${brief.type}`)
    const job = facts.job
    const company = job?.company ?? 'the company'
    try {
      if (brief.type === 'resume') {
        const out = await optimizeResume({
          resumeText: facts.resumeText,
          job: { title: job?.title ?? 'the role', company, description: job?.description ?? null },
          llm,
          signal: ctx.signal,
        })
        return {
          attempts,
          draft: {
            text: out.suggestedRewrite,
            content: { text: out.suggestedRewrite, ats_score: out.rescore.atsScore, matched_keywords: out.matchedKeywords, missing_keywords: out.missingKeywords, format_issues: out.formatIssues },
            title: `Resume for ${job?.title ?? 'a role'} at ${company}`,
            artifactType: 'resume' as const,
          },
        }
      }
      if (brief.type === 'cover_letter') {
        const stepCtx: StepContext = {
          userId: ctx.userId,
          runId: 'agent',
          stepLabel: 'write-cover-letter',
          agentType: 'cv_tailor',
          input: { jobId: job!.id, resumeText: facts.resumeText, ...(instructions ? { correctiveContext: instructions } : {}) },
          deps: {},
          admin: ctx.admin,
          apiKeys: ctx.apiKeys,
          llm,
          signal: ctx.signal ?? new AbortController().signal,
        }
        const { output } = await cv_tailor(stepCtx)
        const out = output as { resumeSummary: string; coverLetter: string; keywords: string[] }
        return {
          attempts,
          draft: {
            text: out.coverLetter,
            content: { text: out.coverLetter, keywords: out.keywords, resume_summary: out.resumeSummary },
            title: `Cover letter for ${job!.title ?? 'a role'} at ${company}`,
            artifactType: 'cover_letter' as const,
          },
        }
      }
      // outreach_email and follow_up
      const relationshipContext = await buildOutreachContext(ctx.admin, ctx.userId, facts.contact?.id ?? null, job?.companyId ?? null)
      const out = await generateOutreachDraft(llm, {
        userName: facts.userName,
        userEmail: ctx.userEmail,
        jobTitle: job?.title ?? 'a role',
        companyName: company,
        contactName: facts.contact?.name ?? null,
        contactTitle: facts.contact?.title ?? null,
        resumeText: facts.resumeText,
        matchHighlights: job?.highlights ?? [],
        jobDescription: job ? frameJobText(job.description, { maxChars: 1500, emptyPlaceholder: '' }) || null : null,
        relationshipContext,
        kind: brief.type === 'follow_up' ? 'follow_up' : 'initial',
        correctiveContext: instructions,
      })
      return {
        attempts,
        draft: {
          text: out.body,
          subject: out.subject,
          content: {
            subject: out.subject,
            body: out.body,
            to_name: facts.contact?.name ?? null,
            to_email: facts.contact?.email ?? null,
            kind: brief.type === 'follow_up' ? 'follow_up' : 'initial',
          },
          title: `${brief.type === 'follow_up' ? 'Follow-up' : 'Email'} to ${facts.contact?.name ?? company}`,
          artifactType: 'outreach_email' as const,
        },
      }
    } catch (e) {
      // The cover letter tailor refuses a draft that claims what the resume does not.
      const message = e instanceof Error ? e.message : String(e)
      if (/refused to return tailored content/.test(message) && attempts < 2) {
        return { attempts, draft: null, corrective: message.replace(/^cv_tailor: refused to return tailored content — /, '') }
      }
      return {
        attempts,
        draft: null,
        result: fail({
          error: /refused to return tailored content/.test(message)
            ? 'Cello could not write a letter that stays inside your resume.'
            : `The draft could not be written: ${message.slice(0, 200)}`,
          fix: /refused to return tailored content/.test(message)
            ? `Tell the person what was refused and ask whether the resume needs updating. Reason: ${message.replace(/^cv_tailor: refused to return tailored content — /, '').slice(0, 300)}`
            : 'Try again, or tell the person it did not work.',
        }),
      }
    }
  }

  // --- review ------------------------------------------------------------------------

  async function review(state: State, config: RunnableConfig) {
    const { brief, facts, draft: d } = state
    if (!brief || !facts || !d) return {}
    activity(config, 'Checking the draft against your resume')
    const kind: DraftKind = brief.type
    const result = await reviewDraft(
      { admin: ctx.admin, userId: ctx.userId, apiKeys: ctx.apiKeys, judge: deps.judge },
      {
        kind,
        text: d.text,
        subject: d.subject,
        resumeText: facts.resumeText,
        job: facts.job ? { title: facts.job.title, company: facts.job.company, description: facts.job.description } : undefined,
        contactName: facts.contact?.name,
        userName: facts.userName,
      }
    )
    return { review: result, corrective: result.passed ? null : result.issues.join(' ') }
  }

  // --- save --------------------------------------------------------------------------

  async function save(state: State, config: RunnableConfig) {
    const { brief, facts, draft: d, review: r } = state
    if (!brief || !facts || !d || !r) return {}
    if (!ARTIFACT_WRITE_TYPES.writer.includes(d.artifactType)) {
      return { result: fail({ error: `The writer does not save a ${d.artifactType}.`, fix: 'Use the right specialist for this type.' }) }
    }
    activity(config, `Saving ${d.title}`)
    const reviewJson = { passed: r.passed, checks: r.checks, issues: r.issues, judge: r.judge }
    let artifactId: string
    let version: number
    if (brief.artifact_id) {
      version = await addVersion(ctx.admin, {
        userId: ctx.userId,
        artifactId: brief.artifact_id,
        author: 'cello',
        content: d.content,
        note: brief.instructions?.slice(0, 300) ?? 'Revised',
        review: reviewJson,
        traceId: ctx.traceId,
        idempotencyKey: brief.idempotency_key,
      })
      artifactId = brief.artifact_id
    } else {
      const ref = await createArtifact(ctx.admin, {
        userId: ctx.userId,
        type: d.artifactType,
        title: d.title,
        content: d.content,
        author: 'cello',
        jobId: facts.job?.id ?? null,
        companyId: facts.job?.companyId ?? null,
        contactId: facts.contact?.id ?? null,
        conversationId: ctx.conversationId,
        idempotencyKey: brief.idempotency_key,
        review: reviewJson,
        traceId: ctx.traceId,
      })
      artifactId = ref.id
      version = ref.version
    }
    const result: WriterResult = {
      status: r.passed ? 'ok' : 'needs_attention',
      artifact_id: artifactId,
      version,
      type: d.artifactType,
      title: d.title,
      preview: (d.subject ? `Subject: ${d.subject}\n\n` : '') + d.text.slice(0, 500),
      review: reviewJson,
      ...(r.passed ? {} : { note: 'The draft is saved with its issues listed. Show them to the person.' }),
    }
    return { result }
  }

  function respond(state: State) {
    const result = state.result ?? fail({ error: 'The writer did not produce a result.', fix: 'Try again.' })
    return { messages: [summaryMessage(result as unknown as Record<string, unknown>)], result }
  }

  const failed = (s: State) => (s.result ? 'respond' : null)

  // Node names must differ from state channel names, so the steps are named for the work.
  return new StateGraph(WriterState)
    .addNode('intake', intake)
    .addNode('gather', gather)
    .addNode('write', draft)
    .addNode('check', review)
    .addNode('save', save)
    .addNode('respond', respond)
    .addEdge(START, 'intake')
    .addConditionalEdges('intake', (s) => failed(s) ?? 'gather', ['gather', 'respond'])
    .addConditionalEdges('gather', (s) => failed(s) ?? 'write', ['write', 'respond'])
    // After a draft: stop on a hard failure, go again when the tailor refused (once), else review.
    .addConditionalEdges('write', (s) => (s.result ? 'respond' : s.draft ? 'check' : 'write'), ['check', 'write', 'respond'])
    // A failed review sends the draft back once with the issues; the second review is shown as it is.
    .addConditionalEdges('check', (s) => (!s.review?.passed && (s.attempts ?? 0) < 2 ? 'write' : 'save'), ['write', 'save'])
    .addEdge('save', 'respond')
    .addEdge('respond', END)
    .compile()
}

/** Run the Writer inline with a structured brief. */
export async function runWriter(deps: WriterDeps, brief: WriterBrief, config?: RunnableConfig): Promise<WriterResult> {
  const out = await invokeSpecialist(buildWriterGraph(deps), { brief, messages: [], attempts: 0 }, config)
  return (out.result as WriterResult | null) ?? fail({ error: 'The writer did not produce a result.', fix: 'Try again.' })
}

export const WRITER_DESCRIPTION =
  'Writes ONE document for the person: a tailored resume, a cover letter, an outreach email or a follow-up. Checks it against their resume, ' +
  `saves it as a draft artifact and never sends. Pass the description as a JSON brief like ${WRITER_BRIEF_SHAPE}. ` +
  'Returns a short JSON summary with the artifact id, a preview and the review result.'

export function writerSubAgent(deps: WriterDeps): CompiledSubAgent {
  return { name: 'writer', description: WRITER_DESCRIPTION, runnable: buildWriterGraph(deps) }
}
