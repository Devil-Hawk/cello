// Outreach emails and follow-ups, through the real writer and review.
//
//   sh scripts/evals/outputs/run.sh outreach --label before|after [--quick] [--stub]
//
// before: the release/1 writer (legacy/outreach.ts), judged by its own autoevals
//         judges on the free judge model, one regeneration on a failure.
// after:  the real writer and reviewOutreachDraft (checks, claims judge,
//         specificity judge, one regeneration).
// Either way the final draft is graded by code (checkDraft against the sender,
// contact and previous email) and by the yardstick judge on a third model family,
// reading the whole resume and the whole job post.

import { fallbackOutreachDraft, generateOutreachDraft, type OutreachDraftInput } from '@/lib/harness/agents/outreach'
import { reviewOutreachDraft } from '@/lib/graph/verify/outreach-review'
import { checkDraft } from '@/lib/writing/checks'
import { legacyFallbackOutreach, legacyGenerateOutreach, type OutreachDraftInput as LegacyInput } from './legacy/outreach'
import { legacyGroundedness, legacySpecificity } from './legacy/judges'
import { PRODUCTION_JUDGE_MODEL, WRITER_MODEL, YARDSTICK_MODEL, freeRunner, job, load, metricFrom, report, resumeText, run, start, wordCount, yardstick } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  kind: 'initial' | 'follow_up'
  resume: string
  sender: string
  jobId: string | null
  company: string
  contact: { name: string; title: string } | null
  previous?: { subject: string; body: string; daysSince: number }
}

/** What release/1's buildOutreachContext handed the writer for a contact with no history. */
const LEGACY_NO_HISTORY =
  'RELATIONSHIP HISTORY: none recorded. Do not claim a prior conversation, reply, or any existing familiarity with this person or company — this is a first contact.'

async function main() {
  const args = start()
  const items = load<Item>('outreach', args)
  const writer = freeRunner(WRITER_MODEL)
  const judgeRun = freeRunner(PRODUCTION_JUDGE_MODEL)
  const checkRows: { id: string; ok: boolean }[] = []
  const groundedRows: { id: string; ok: boolean }[] = []
  const specificRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []
  let templates = 0
  let templatesWithoutNotice = 0
  let words = 0

  for (const item of items) {
    const resume = resumeText(item.resume)
    const j = item.jobId ? job(item.jobId) : null
    const common = {
      userName: item.sender,
      userEmail: 'sender@example.com',
      contactName: item.contact?.name ?? null,
      contactTitle: item.contact?.title ?? null,
      resumeText: resume,
      jobDescription: j?.description ?? null,
      kind: item.kind,
    }

    let subject: string
    let body: string
    let isTemplate: boolean
    let withoutNotice: boolean

    if (args.label === 'before') {
      const input: LegacyInput = {
        ...common,
        jobTitle: j?.title ?? 'a role',
        companyName: item.company,
        matchHighlights: [],
        relationshipContext: item.kind === 'initial' ? LEGACY_NO_HISTORY : null,
      }
      let draft = await legacyGenerateOutreach(writer, input)
      const first = draft
      const isTpl = (d: { body: string }) => d.body === legacyFallbackOutreach(input).body
      if (!isTpl(draft)) {
        // release/1's review: autoevals groundedness and specificity, one regeneration on a failure.
        const sourceFacts = `CANDIDATE RESUME:\n${resume}\n\nVERIFIED MATCH HIGHLIGHTS: (none)\n\nJOB FACTS:\nTitle: ${input.jobTitle}\nCompany: ${item.company}\nDescription:\n${(j?.description ?? '').slice(0, 1500)}`
        const [g, s] = await Promise.all([
          legacyGroundedness(PRODUCTION_JUDGE_MODEL, draft.body, sourceFacts).catch(() => ({ pass: true, score: null })),
          legacySpecificity(PRODUCTION_JUDGE_MODEL, draft.body, `${item.company}, ${input.jobTitle}`).catch(() => ({ pass: true, score: null })),
        ])
        if (!g.pass || !s.pass) {
          const regen = await legacyGenerateOutreach(writer, { ...input, correctiveContext: 'The previous draft was flagged as ungrounded or generic. Use only facts from the resume and job post, and name a specific detail.' })
          if (regen.tokensUsed > 0) draft = regen
        }
      }
      subject = draft.subject
      body = draft.body
      isTemplate = isTpl(draft)
      // release/1 stored used_llm = tokensUsed > 0 and showed only a tooltip badge: a template was never visibly flagged.
      withoutNotice = isTemplate
      void first
    } else {
      const input: OutreachDraftInput = {
        ...common,
        jobTitle: j?.title ?? null,
        companyName: item.company,
        facts: [],
        history: [],
        previousEmail: item.previous ? { subject: item.previous.subject, body: item.previous.body } : null,
        daysSinceSent: item.previous?.daysSince ?? null,
      }
      const draft = await generateOutreachDraft(writer, input)
      const review = await reviewOutreachDraft({ generate: (i) => generateOutreachDraft(writer, i), claimsRun: judgeRun, specificityRun: judgeRun }, input, draft)
      subject = review.subject
      body = review.body
      isTemplate = review.source === 'template'
      withoutNotice = isTemplate && !review.templateReason
      void fallbackOutreachDraft
    }

    if (isTemplate) templates++
    if (withoutNotice) templatesWithoutNotice++
    words += wordCount(body)

    const checks = checkDraft({
      kind: item.kind === 'follow_up' ? 'follow_up' : 'outreach',
      subject,
      body,
      senderName: item.sender,
      contactName: item.contact?.name,
      companyName: item.company,
      hasHistory: item.kind === 'follow_up',
      previousBody: item.previous?.body,
    })
    checkRows.push({ id: item.id, ok: checks.ok })

    const claims = await yardstick('claims', `<resume>\n${resume}\n</resume>\n<job>\n${j?.description ?? '(no job post)'}\n</job>\n<draft>\n${body}\n</draft>`)
    const unsupported = Array.isArray(claims?.unsupported) ? (claims!.unsupported as unknown[]) : null
    if (unsupported) groundedRows.push({ id: item.id, ok: unsupported.length === 0 })
    if (j) {
      const spec = await yardstick('specific', `<job>\n${j.description}\n</job>\n<draft>\n${body}\n</draft>`)
      if (typeof spec?.specific === 'boolean') specificRows.push({ id: item.id, ok: spec.specific })
    }
    rows.push({ id: item.id, kind: item.kind, subject, body, template: isTemplate, failedChecks: checks.checks.filter((c) => !c.ok).map((c) => c.id), unsupported })
    console.log(`${item.id} ${isTemplate ? 'template' : 'model'} checks=${checks.ok ? 'ok' : checks.checks.filter((c) => !c.ok).map((c) => c.id).join(',')}`)
  }

  const metrics: Metric[] = [
    metricFrom('all checks pass', checkRows),
    metricFrom('grounded (yardstick)', groundedRows, `judged ${groundedRows.length} of ${items.length}`),
    metricFrom('specific (yardstick)', specificRows, 'items with job text'),
    { name: 'template without notice', value: templatesWithoutNotice, n: templates, kind: 'count', note: `${templates} templates in ${items.length} drafts` },
    { name: 'average words', value: Math.round(words / Math.max(1, items.length)), n: items.length, kind: 'count' },
  ]
  report('outreach', args, `production ${PRODUCTION_JUDGE_MODEL}, yardstick ${YARDSTICK_MODEL}`, metrics, rows)
}

run(main)
