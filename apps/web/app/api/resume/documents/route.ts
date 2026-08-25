// /api/resume/documents — CRUD + generation surface for versioned resumes
// (public.resume_documents).
//
// POST { action }
//   'generate' { jobId }
//     Runs the harness resume_optimizer (lib/harness/agents/resume_optimizer's
//     optimizeResumeAndSave) against the signed-in user's profiles.resume_text
//     for the given job, and persists the rewrite as a new tailored version.
//     Same three-serial-LLM-call shape as /api/resume/optimize, hence the
//     same maxDuration = 300.
//   'save' { jobId: string | null, markdown | content, templateId?, title?, source }
//     Append a new version (createVersion) — the user's manual edit / a
//     freshly-uploaded base resume. jobId: null targets the base bucket.
//     `markdown` is the AUTHORED document; the stored plain text is DERIVED
//     from it here via markdownToPlainText, and the template id is stored
//     alongside it in content_json. A caller that sends only `content` (the
//     pre-formatting clients) is treated as sending plain-text Markdown, which
//     round-trips byte-for-byte — see lib/resume/types.ts's ResumeContentJson
//     doc comment for why these two strings may never be authored separately.
//   'delete' { id }
//     Remove one version the user owns.
//
// GET
//   ?jobId=<uuid>        -> { versions: tailored versions for that job, base: latest base version | null }
//   ?jobId=base (or omitted) -> { versions: base-bucket versions, base: null }
//   ?id=<uuid>&format=pdf|docx -> a stream of that one version, rendered from
//     its MARKDOWN through the chosen template (see EXPORT_FORMATS)
//
// Auth: same cookie-session pattern as every other /api/resume/* route.
// Ownership: every store.ts call is scoped by the signed-in user's id — see
// lib/resume/store.ts's header comment for why that predicate matters even
// though we read/write through the service-role admin client.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { optimizeResumeAndSave } from '@/lib/harness/agents/resume_optimizer'
import { callLlm, MissingKeyError } from '@/lib/harness/llm'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import {
  createMarkdownVersion,
  deleteVersion,
  getBaseResume,
  getVersionById,
  listVersions,
} from '@/lib/resume/store'
import { isResumeSource, type ResumeContentJson } from '@/lib/resume/types'
import { markdownToPlainText } from '@/lib/resume/markdown'
import { DEFAULT_TEMPLATE_ID, isTemplateId } from '@/lib/resume/templates'
import { renderResumeVersionPdf } from '@/lib/resume/pdf'
import { renderResumeVersionDocx } from '@/lib/resume/docx'
import type { DecryptedApiKeys, LlmRunner } from '@/lib/harness/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// --- shared helpers ----------------------------------------------------

function bad(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status })
}

/** Turn a resume title (or none) into a safe Content-Disposition filename. */
/** The export formats this route can actually produce. Keyed by the `format`
 *  query value, so adding one here is the only change a new exporter needs.
 *  Both renderers take the resume_documents ROW (not doc.content) — see the
 *  comment at the render call for why that distinction is load-bearing. */
const EXPORT_FORMATS = {
  pdf: {
    ext: 'pdf',
    contentType: 'application/pdf',
    render: renderResumeVersionPdf,
  },
  docx: {
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    render: renderResumeVersionDocx,
  },
} as const

type ExportFormat = keyof typeof EXPORT_FORMATS

function isExportFormat(value: string | null): value is ExportFormat {
  return value !== null && Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, value)
}

function exportFilename(title: string | null, version: number, ext: string): string {
  const base = (title ?? `resume-v${version}`).trim() || `resume-v${version}`
  const safe = base.replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/\s+/g, '-')
  return `${safe || `resume-v${version}`}.${ext}`
}

// --- GET -----------------------------------------------------------------

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  const admin = createAdminClient()
  const { searchParams } = request.nextUrl

  const id = searchParams.get('id')
  const format = searchParams.get('format')

  // --- single-document PDF export ---
  if (id) {
    if (!isExportFormat(format)) {
      return bad(
        `GET with \`id\` requires \`format\` to be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}`
      )
    }
    const exporter = EXPORT_FORMATS[format]
    let doc
    try {
      doc = await getVersionById(admin, user.id, id)
    } catch (err) {
      return bad(err instanceof Error ? err.message : 'Failed to load resume version', 500)
    }
    if (!doc) return bad('Resume version not found', 404)

    let bytes: Uint8Array
    try {
      // renderResumeVersionPdf, NOT renderResumePdf(doc.content): `content` is
      // the DERIVED plain text, so passing it renders every export as
      // unformatted paragraphs in the DEFAULT template — silently, because both
      // parameters are strings and it still compiles. The version helper reads
      // content_json.markdown and content_json.templateId through the
      // persistence contract, and falls back to the plain text for the legacy
      // rows (content_json === null) that predate formatting.
      // The template TRAVELS WITH THE REQUEST. Changing the picker does not
      // auto-save (the page only enables Save), so without this a user who
      // picks a template and downloads without saving silently receives the
      // previously saved one — the exact flow the download menu advertises.
      // An unknown/absent id falls through to the stored content_json value,
      // because renderResumeVersion* spreads opts AFTER its own templateId.
      const templateOverride = searchParams.get('templateId')
      bytes = await exporter.render(
        doc,
        isTemplateId(templateOverride) ? { templateId: templateOverride } : {}
      )
    } catch (err) {
      console.error('[resume/documents] export render failed', { id, format, userId: user.id }, err)
      return bad(`Failed to render ${format.toUpperCase()}`, 500)
    }

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': exporter.contentType,
        'Content-Disposition': `attachment; filename="${exportFilename(doc.title, doc.version, exporter.ext)}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // --- version listing (a job bucket, or the base bucket) ---
  const jobIdParam = searchParams.get('jobId')
  const bucketJobId = !jobIdParam || jobIdParam === 'base' ? null : jobIdParam

  try {
    const versions = await listVersions(admin, user.id, bucketJobId)
    const base = bucketJobId === null ? null : await getBaseResume(admin, user.id)
    return NextResponse.json({ versions, base })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to load resume versions', 500)
  }
}

// --- POST ------------------------------------------------------------------

interface GenerateBody {
  action: 'generate'
  jobId: string
}

interface SaveBody {
  action: 'save'
  jobId: string | null
  /** The AUTHORED resume. Preferred; `content` is the legacy spelling. */
  markdown?: string
  /** Legacy: plain text. Treated as Markdown (plain text is valid Markdown). */
  content?: string
  /** Template to render this version with. Unknown ids fall back to the default. */
  templateId?: string
  /** Extra structured keys to preserve (e.g. `sections`). */
  contentJson?: ResumeContentJson | null
  title?: string | null
  source: string
}

interface DeleteBody {
  action: 'delete'
  id: string
}

type PostBody = GenerateBody | SaveBody | DeleteBody

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  let body: Partial<PostBody>
  try {
    body = await request.json()
  } catch {
    return bad('Invalid JSON body')
  }

  const admin = createAdminClient()

  switch (body.action) {
    case 'generate':
      return handleGenerate(admin, supabase, user.id, body)
    case 'save':
      return handleSave(admin, user.id, body)
    case 'delete':
      return handleDelete(admin, user.id, body)
    default:
      return bad("action must be one of 'generate', 'save', 'delete'")
  }
}

// --- action handlers ---------------------------------------------------

/**
 * optimizeResume() always issues its three LLM calls in this fixed order —
 * see lib/harness/agents/resume_optimizer.ts's optimizeResume: scoreResume
 * (original), rewriteResume, scoreResume (rescore). Mirrors the same counter
 * trick /api/resume/optimize uses so a failure names the in-flight pass.
 */
const PASS_LABELS = ['score original resume', 'generate ATS rewrite', 'rescore rewrite'] as const

function trackedLlm(apiKeys: DecryptedApiKeys): { llm: LlmRunner; passIndex: () => number } {
  let started = 0
  const llm: LlmRunner = (opts) => {
    started += 1
    return callLlm(apiKeys, opts)
  }
  return { llm, passIndex: () => started }
}

async function handleGenerate(
  admin: ReturnType<typeof createAdminClient>,
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  body: Partial<GenerateBody>
) {
  const jobId = typeof body.jobId === 'string' ? body.jobId : ''
  if (!jobId) return bad('jobId is required')

  const { data: profile } = await admin
    .from('profiles')
    .select('resume_text')
    .eq('id', userId)
    .single()
  const resumeText = ((profile?.resume_text as string | null) ?? '').trim()
  if (!resumeText) {
    return bad('No resume on file. Upload your resume in Settings first.', 400, { needsResume: true })
  }

  // RLS-scoped read (matches /api/resume/optimize's pattern) — jobs aren't
  // per-user rows, but this keeps the lookup typed against @cello/shared's
  // generated Database type instead of the untyped admin client.
  const { data: job } = await supabase
    .from('jobs')
    .select('id, title, description, companies(name)')
    .eq('id', jobId)
    .single()
  if (!job) return bad('Job not found', 404)

  const companyRel = (job as { companies?: { name?: string } | { name?: string }[] | null }).companies
  const companyName = Array.isArray(companyRel) ? companyRel[0]?.name : companyRel?.name

  const apiKeys = await loadApiKeys(admin, userId)
  if (!canRunLlm(apiKeys)) {
    return bad(missingOpenRouterMessage(apiKeys), 400, { needsKey: true })
  }

  const { llm, passIndex } = trackedLlm(apiKeys)
  try {
    const { document, ...optimization } = await optimizeResumeAndSave({
      resumeText,
      job: { title: job.title as string, company: companyName ?? null, description: job.description as string | null },
      llm,
      client: admin,
      userId,
      jobId,
      source: 'tailored',
    })
    return NextResponse.json({ document, optimization })
  } catch (err) {
    const idx = passIndex()
    const pass = idx >= 1 && idx <= PASS_LABELS.length ? PASS_LABELS[idx - 1] : null
    const baseMessage = err instanceof Error ? err.message : 'Resume optimization failed'
    console.error(
      `[resume/documents] generate job=${jobId} user=${userId} pass="${pass ?? 'unknown'}" (call #${idx}) failed:`,
      err
    )
    if (err instanceof MissingKeyError) {
      return bad(missingOpenRouterMessage(apiKeys), 400, { needsKey: true, pass })
    }
    return bad(pass ? `Resume optimization failed during "${pass}": ${baseMessage}` : baseMessage, 500, {
      pass,
      passIndex: idx || null,
    })
  }
}

async function handleSave(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  body: Partial<SaveBody>
) {
  // ONE authored string in, both stored strings derived from it. A caller that
  // sends only `content` predates formatting and is sending plain text, which
  // is valid Markdown and round-trips through markdownToPlainText unchanged —
  // so treating it as the Markdown keeps those clients working AND keeps
  // content_json.markdown in step with content, which is the invariant
  // lib/resume/types.ts exists to protect.
  const markdown =
    (typeof body.markdown === 'string' ? body.markdown : typeof body.content === 'string' ? body.content : '').trim()
  if (!markdown) return bad('markdown (or content) is required')

  const content = markdownToPlainText(markdown)
  if (!content.trim()) return bad('markdown contains no readable text')

  if (!isResumeSource(body.source)) {
    return bad("source must be one of 'base', 'tailored', 'edited'")
  }

  const jobId = typeof body.jobId === 'string' && body.jobId ? body.jobId : null
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null
  // An unknown id is not an error — getTemplate() degrades it at render time —
  // but there is no reason to persist a typo, so it lands on the default here.
  const templateId = isTemplateId(body.templateId) ? body.templateId : DEFAULT_TEMPLATE_ID
  const base =
    body.contentJson && typeof body.contentJson === 'object' ? (body.contentJson as ResumeContentJson) : null

  try {
    // createMarkdownVersion derives `content` and content_json itself, so this
    // route has no way to write a plain text that disagrees with the Markdown.
    const document = await createMarkdownVersion(admin, {
      userId,
      jobId,
      title,
      markdown,
      templateId,
      baseContentJson: base,
      source: body.source,
    })
    return NextResponse.json({ document })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to save resume version', 500)
  }
}

async function handleDelete(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  body: Partial<DeleteBody>
) {
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return bad('id is required')

  try {
    const existing = await getVersionById(admin, userId, id)
    if (!existing) return bad('Resume version not found', 404)
    await deleteVersion(admin, userId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to delete resume version', 500)
  }
}
