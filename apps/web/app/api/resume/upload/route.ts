// POST /api/resume/upload — bring a resume in, in whatever format the user has.
//
// ACCEPTS
//   multipart/form-data with `resume`: a .pdf, .docx, .txt or .md file (5MB max)
//   multipart/form-data with `text`:   resume text pasted into a textarea
//   application/json  { text }:        the same, for non-form callers
//
// WHAT CHANGED AND WHY
//   This route used to reject everything that did not end in `.pdf`, flatten
//   the PDF to a string, optionally ask a model to "clean it up and format it
//   nicely", and store the resulting text in profiles.resume_text. Three things
//   were wrong with that:
//     1. "Any word or pdf or txt" is the actual requirement. A .docx is the
//        HIGHEST-fidelity resume input there is — Word stores real heading
//        styles, bold runs and list levels — and it was the one format we
//        refused outright.
//     2. Flattening threw away every bit of structure, so every resume looked
//        identical downstream no matter what the user uploaded.
//     3. "Clean it up and format it nicely" is an invitation for a model to
//        improve prose and invent achievements, and nothing checked that it
//        hadn't.
//   The parsing now lives in lib/resume/import (one module per format, with the
//   honest note about how much structure each format actually carries), the
//   model's job is reformatting under a strict instruction set, and its output
//   is word-set-checked against the source before it is allowed anywhere near
//   the user's resume.
//
// WHAT IT WRITES (both of these, always together)
//   profiles.resume_text            <- the DERIVED ATS plain text, unchanged in
//                                      meaning for every existing reader
//                                      (matching, optimizer, apply paths).
//   resume_documents (base bucket)  <- a new append-only version carrying the
//                                      AUTHORED Markdown in
//                                      content_json.markdown plus the template
//                                      id, per lib/resume/types.ts. This is what
//                                      lets the studio open a FORMATTED resume
//                                      and the exporter render a real template.
//   The two strings are never authored independently — importResume* derives
//   the plain text from the Markdown in one place. See ResumeContentJson's doc
//   comment for why that matters.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { BudgetCapError } from '@/lib/harness/spend'
import { callLlm } from '@/lib/harness/llm'
import { resumePhotoStep } from '@/lib/steps'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { createMarkdownVersion, getBaseResume } from '@/lib/resume/store'
import { getResumeTemplateId } from '@/lib/resume/types'
import { DEFAULT_TEMPLATE_ID } from '@/lib/resume/templates'
import {
  importPastedResume,
  importResumeFile,
  ResumeImportError,
  RESUME_UPLOAD_MAX_BYTES,
  RESUME_UPLOAD_MAX_LABEL,
  SUPPORTED_FORMATS_SENTENCE,
  RESUME_MARKDOWN_PROMPT,
  type ResumeImportModels,
  type ResumeImportResult,
} from '@/lib/resume/import'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { setTraceInput, setTraceOutput, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
// A vision read of a long PDF plus a reformat pass is comfortably slower than
// the default 10s. Still well under the optimizer's 300.
export const maxDuration = 120

/** Enough for a long resume in Markdown; a truncated resume is a corrupt one. */
const MAX_OUTPUT_TOKENS = 8000

// --- model access (all of it optional) -------------------------------------

/**
 * Wire whichever models this account actually has. Every field may be null —
 * lib/resume/import falls back to deterministic structure inference, so an
 * account with no keys at all still gets a structured resume.
 */
function buildModels(apiKeys: DecryptedApiKeys): ResumeImportModels {
  const models: ResumeImportModels = {}

  if (apiKeys.anthropic) {
    // The only way to recover a scanned, image-only resume, and the best reader for a multi-column
    // layout. It is a model, so lib/resume/import cross-checks its answer against the text unpdf
    // extracts whenever there is any. The resume.photo step picks the rung, the model and the key.
    models.readPdf = async (pdfBase64) => {
      const result = await resumePhotoStep.call(
        apiKeys,
        { prompt: RESUME_MARKDOWN_PROMPT, files: [{ mimeType: 'application/pdf', data: pdfBase64 }], maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 },
        { door: 'session' }
      )
      return result.content
    }
  }

  // The harness runner: honours the account's provider choice, enforces the monthly spend cap and
  // retries transient failures. An account with only an OpenAI key goes to it directly.
  const direct = !canRunLlm(apiKeys) && apiKeys.openai
  if (canRunLlm(apiKeys) || direct) {
    models.reformat = async (prompt) => {
      const result = await callLlm(apiKeys, {
        prompt,
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        name: 'import-resume',
        ...(direct ? { via: 'openai' as const, model: 'gpt-4o-mini' } : {}),
      })
      return result.content
    }
  }

  return models
}

// --- persistence ------------------------------------------------------------

/** Filename without its extension, as the version title. */
function titleFromFilename(filename: string | null): string | null {
  if (!filename) return null
  const base = filename.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '').trim()
  return stem ? stem.slice(0, 80) : null
}

/**
 * Persist an import as the new base resume.
 *
 * Writes profiles.resume_text (the plain text every existing reader consumes)
 * and appends a resume_documents version carrying the Markdown. The version
 * write is best-effort ON PURPOSE: profiles.resume_text is what matching and
 * the optimizer read, so a failure there must fail the request, while a failure
 * to append the studio version should degrade to a warning rather than throw
 * away a resume the user just successfully parsed.
 */
async function persistImport(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  result: ResumeImportResult,
  filename: string | null
): Promise<{ documentId: string | null; version: number | null; warnings: string[] }> {
  const { error } = await supabase.from('profiles').update({ resume_text: result.plainText }).eq('id', userId)
  if (error) throw error

  const admin = createAdminClient()
  try {
    // Keep whatever template this user already chose for their base resume —
    // re-uploading a resume is not a request to restyle it.
    const previous = await getBaseResume(admin, userId)
    const templateId = getResumeTemplateId(previous?.content_json) ?? DEFAULT_TEMPLATE_ID

    // createMarkdownVersion, not createVersion: it derives `content` from the
    // Markdown itself, so the row cannot be written with a plain text that
    // describes a different resume than content_json.markdown does.
    const document = await createMarkdownVersion(admin, {
      userId,
      jobId: null,
      title: titleFromFilename(filename),
      markdown: result.markdown,
      templateId,
      source: 'base',
    })
    return { documentId: document.id, version: document.version, warnings: [] }
  } catch (err) {
    console.error('[resume/upload] failed to append resume_documents version', { userId }, err)
    return {
      documentId: null,
      version: null,
      warnings: [
        'Your resume text was saved, but the formatted version could not be stored — open the resume studio and save it again to keep the formatting.',
      ],
    }
  }
}

// --- route ------------------------------------------------------------------

interface ParsedRequest {
  file: { filename: string | null; mimeType: string | null; bytes: Buffer } | null
  text: string | null
}

async function parseRequest(request: NextRequest): Promise<ParsedRequest> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null
    return { file: null, text: typeof body?.text === 'string' ? body.text : null }
  }

  const formData = await request.formData()
  const uploaded = formData.get('resume')
  const pasted = formData.get('text')

  if (uploaded && typeof uploaded === 'object' && 'arrayBuffer' in uploaded) {
    const file = uploaded as File
    // Check the declared size BEFORE buffering the body — reading a 500MB
    // upload into memory just to reject it is how a route gets OOM-killed.
    if (file.size > RESUME_UPLOAD_MAX_BYTES) {
      throw new ResumeImportError('too_large', `File too large (max ${RESUME_UPLOAD_MAX_LABEL}).`)
    }
    return {
      file: {
        filename: file.name || null,
        mimeType: file.type || null,
        bytes: Buffer.from(await file.arrayBuffer()),
      },
      text: null,
    }
  }

  return { file: null, text: typeof pasted === 'string' ? pasted : null }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return withTrace(createAdminClient(), user.id, { name: 'import-resume' }, async () => {

    let parsed: ParsedRequest
    try {
      parsed = await parseRequest(request)
    } catch (err) {
      if (err instanceof ResumeImportError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      }
      return NextResponse.json({ error: 'Could not read the upload' }, { status: 400 })
    }

    if (!parsed.file && !parsed.text?.trim()) {
      return NextResponse.json(
        { error: `No resume provided. Upload ${SUPPORTED_FORMATS_SENTENCE}, or paste your resume text.` },
        { status: 400 }
      )
    }
    // Kind and size only: the resume itself is not a trace input.
    setTraceInput({ source: parsed.file ? 'file' : 'pasted_text' })

    const { getDecryptedApiKeys } = await import('@/lib/apikeys')
    const apiKeys = await getDecryptedApiKeys(user.id)
    // Spend: both legs of buildModels (the photo step and callLlm) reserve and settle their own
    // cost (lib/harness/spend.ts), on the person's own key too. A capped user's call throws
    // BudgetCapError, answered below.
    const models = buildModels(apiKeys)

    let result: ResumeImportResult
    try {
      result = parsed.file
        ? await importResumeFile(parsed.file, models)
        : await importPastedResume(parsed.text ?? '', models)
    } catch (err) {
      if (err instanceof BudgetCapError) {
        return NextResponse.json({ error: err.message, budgetExhausted: true }, { status: 429 })
      }
      if (err instanceof ResumeImportError) {
        // Every one of these is something the user can act on, and the message
        // says what to do — do not flatten them into "Failed to process resume".
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      }
      console.error('[resume/upload] import failed', { userId: user.id }, err)
      return NextResponse.json({ error: 'Failed to process resume' }, { status: 500 })
    }

    let persisted: Awaited<ReturnType<typeof persistImport>>
    try {
      persisted = await persistImport(supabase, user.id, result, parsed.file?.filename ?? null)
    } catch (err) {
      console.error('[resume/upload] save failed', { userId: user.id }, err)
      return NextResponse.json({ error: 'Failed to save resume' }, { status: 500 })
    }

    const warnings = [...result.warnings, ...persisted.warnings]
    setTraceOutput({ format: result.format, method: result.method, warnings: warnings.length })

    return NextResponse.json({
      success: true,
      message: `Resume imported from ${result.format.toUpperCase()} · ${result.method}`,
      // `extractionMethod` and `wordCount` are the field names the settings card
      // already renders — kept.
      extractionMethod: result.method,
      wordCount: result.plainText.split(/\s+/).filter(Boolean).length,
      format: result.format,
      structurePreserved: result.structurePreserved,
      warnings,
      documentId: persisted.documentId,
      version: persisted.version,
    })
  })
}
