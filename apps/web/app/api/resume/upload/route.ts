// POST /api/resume/upload: bring a resume in, in whatever form the user has it.
//
// EVERY INPUT ENDS AS A VALID STRUCTURED Resume (lib/resume/schema.ts):
//   multipart `resume` file   .pdf .docx .txt .md        -> text -> structure -> save
//   multipart/JSON `text`     pasted text, or a photo/scan transcript
//   multipart `resume` + mode=transcribe
//                             a photo (png/jpg/webp) or scanned PDF -> { text }
//                             via a vision model on the owner's OpenRouter key.
//                             Nothing is saved and nothing is structured yet.
//
// A PICTURE NEVER WRITES DIRECTLY. A transcription can misread a name or a
// number, and no check can catch that (the structure is compared with the
// transcript, not the picture), so the client shows the result next to the
// picture and the user confirms. That is why the structure step takes
// `persist: false` and returns { resume, warnings } without saving; the
// review sheet then saves through POST /api/resume/documents.
//
// STATUS CODES THE CLIENT ACTS ON (body.code)
//   422 needs_transcribe   a scanned PDF or a picture: re-send with mode=transcribe
//   422 needs_ocr          no vision key on the server: read it in the browser
//   502 transcribe_failed  the vision call failed
//
// WHAT IT WRITES
//   resume_documents (base bucket) <- one new append-only version with the
//   structured Resume in content_json.resume. profiles.resume_text is NOT
//   written here: a database trigger mirrors the latest base version's text
//   into it (supabase/migrations/20261009000700_resume_text_mirror.sql), so
//   every writer is covered and the mirror cannot drift.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isDemoUser } from '@/lib/agents/api'
import { setTraceInput, setTraceOutput, withTrace } from '@/lib/trace/spans'
import { callLlm } from '@/lib/harness/llm'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { createResumeVersion, getBaseResume } from '@/lib/resume/store'
import { getResumeTemplateId } from '@/lib/resume/types'
import { DEFAULT_TEMPLATE_ID } from '@/lib/resume/templates'
import type { ParsedFrom, Resume } from '@/lib/resume/schema'
import {
  detectResumeFormat,
  heicError,
  importPastedResume,
  importResumeFile,
  isHeic,
  isImageFormat,
  ResumeImportError,
  RESUME_UPLOAD_MAX_BYTES,
  RESUME_UPLOAD_MAX_LABEL,
  SUPPORTED_FORMATS_SENTENCE,
  type ResumeFormat,
  type ResumeImportResult,
} from '@/lib/resume/import'
import { structureResume } from '@/lib/resume/import/structure'
import { transcribeWithAnthropic, transcribeWithOpenRouter, type TranscribeInput } from '@/lib/resume/import/vision'

export const dynamic = 'force-dynamic'
// A vision read plus a structure pass is comfortably slower than the default
// 10s. Still well under the optimizer's 300.
export const maxDuration = 120

const TRANSCRIBE_MIME: Partial<Record<ResumeFormat, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

/** Filename without its extension, as the version title. */
function titleFromFilename(filename: string | null): string | null {
  if (!filename) return null
  const base = filename.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '').trim()
  return stem ? stem.slice(0, 80) : null
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status })

function importFailure(err: ResumeImportError) {
  return fail(err.status, err.message, { code: err.code })
}

// --- request ------------------------------------------------------------------

interface ParsedRequest {
  file: { filename: string | null; mimeType: string | null; bytes: Buffer } | null
  text: string | null
  mode: 'import' | 'transcribe'
  persist: boolean
  parsedFrom: ParsedFrom | null
}

const PICTURE_SOURCES: readonly ParsedFrom[] = ['image', 'scan']

async function parseRequest(request: NextRequest): Promise<ParsedRequest> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as {
      text?: unknown
      parsedFrom?: unknown
      persist?: unknown
    } | null
    const from = PICTURE_SOURCES.find((p) => p === body?.parsedFrom) ?? null
    return {
      file: null,
      text: typeof body?.text === 'string' ? body.text : null,
      mode: 'import',
      persist: body?.persist !== false,
      parsedFrom: from,
    }
  }

  const formData = await request.formData()
  const uploaded = formData.get('resume')
  const pasted = formData.get('text')
  const mode = formData.get('mode') === 'transcribe' ? 'transcribe' : 'import'

  if (uploaded && typeof uploaded === 'object' && 'arrayBuffer' in uploaded) {
    const file = uploaded as File
    // Check the declared size BEFORE buffering the body: reading a 500MB
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
      mode,
      persist: formData.get('persist') !== 'false',
      parsedFrom: null,
    }
  }

  return {
    file: null,
    text: typeof pasted === 'string' ? pasted : null,
    mode,
    persist: formData.get('persist') !== 'false',
    parsedFrom: null,
  }
}

// --- transcription ----------------------------------------------------------

/**
 * Read a picture or a scanned PDF. The owner's OpenRouter key is the vision
 * path; a direct Anthropic key is used only when it is the only key. With
 * neither, the answer is `needs_ocr` and the browser reads it locally.
 */
async function transcribe(
  parsed: ParsedRequest,
  apiKeys: { openrouter?: string | null; anthropic?: string | null }
): Promise<NextResponse> {
  const file = parsed.file
  if (!file) return fail(400, 'Choose a photo or a PDF to read.')
  if (isHeic(file.filename, file.mimeType)) return importFailure(heicError())

  const format = detectResumeFormat(file.filename, file.mimeType)
  const mimeType = format ? TRANSCRIBE_MIME[format] : undefined
  if (!format || !mimeType || !(isImageFormat(format) || format === 'pdf')) {
    return fail(400, `That is not a picture or a PDF. Upload ${SUPPORTED_FORMATS_SENTENCE}.`, {
      code: 'unsupported_format',
    })
  }

  const input: TranscribeInput = { bytes: file.bytes, mimeType, filename: file.filename }
  try {
    if (apiKeys.openrouter) return NextResponse.json({ text: await transcribeWithOpenRouter(apiKeys.openrouter, input) })
    if (apiKeys.anthropic) return NextResponse.json({ text: await transcribeWithAnthropic(apiKeys.anthropic, input) })
  } catch (err) {
    console.error('[resume/upload] transcribe failed', err)
    return fail(502, 'We could not read this picture.', { code: 'transcribe_failed' })
  }
  return fail(422, 'No vision model is available on the server, so this will be read in your browser.', {
    code: 'needs_ocr',
  })
}

// --- route --------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return fail(401, 'Unauthorized')
  return withTrace(createAdminClient(), user.id, { name: 'import-resume' }, () => importResume(request, user))
}

async function importResume(request: NextRequest, user: { id: string; email?: string | null }) {
  let parsed: ParsedRequest
  try {
    parsed = await parseRequest(request)
  } catch (err) {
    if (err instanceof ResumeImportError) return importFailure(err)
    return fail(400, 'Could not read the upload')
  }

  if (!parsed.file && !parsed.text?.trim()) {
    return fail(400, `No resume provided. Upload ${SUPPORTED_FORMATS_SENTENCE}, or paste your resume text.`)
  }

  // Kind and size only: the resume itself is not a trace input.
  setTraceInput({ source: parsed.file ? 'file' : 'pasted_text', mode: parsed.mode })

  const { getDecryptedApiKeys } = await import('@/lib/apikeys')
  const apiKeys = await getDecryptedApiKeys(user.id)
  const budgetAdmin = createAdminClient()

  if (parsed.mode === 'transcribe') {
    // A photo is read straight through the person's own provider key (lib/resume/import/vision.ts), so it
    // costs the Cello ledger nothing. A demo holds Cello's key, so a demo may not do it.
    if (await isDemoUser(budgetAdmin, user.id)) return fail(403, 'Demo accounts cannot read photos. Paste your resume text instead.', { code: 'demo_blocked' })
    return transcribe(parsed, apiKeys)
  }

  // --- text -> markdown ---
  let result: ResumeImportResult
  try {
    result = parsed.file ? await importResumeFile(parsed.file) : await importPastedResume(parsed.text ?? '')
  } catch (err) {
    if (err instanceof ResumeImportError) return importFailure(err)
    console.error('[resume/upload] import failed', { userId: user.id }, err)
    return fail(500, 'Failed to process resume')
  }

  // --- markdown -> a structured Resume ---
  const { data: profile } = await budgetAdmin.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle()
  const parsedFrom: ParsedFrom =
    parsed.parsedFrom ?? (parsed.file ? (result.format === 'png' || result.format === 'jpg' || result.format === 'webp' ? 'image' : result.format) : 'paste')
  let resume: Resume
  let structureWarnings: string[]
  try {
    const structured = await structureResume(result.markdown, result.plainText, {
      // The harness runner: honours the account's provider choice, enforces the
      // monthly spend cap and retries transient failures. No key, no LLM leg:
      // the deterministic structure is used and still valid.
      run: canRunLlm(apiKeys) ? (opts) => callLlm(apiKeys, { ...opts, name: opts.name ?? 'import-resume' }) : null,
      nameCtx: {
        fullName: (profile as { full_name?: string | null } | null)?.full_name ?? null,
        email: (profile as { email?: string | null } | null)?.email ?? user.email ?? null,
      },
      parsedFrom,
    })
    resume = structured.resume
    structureWarnings = structured.warnings
  } catch (err) {
    console.error('[resume/upload] structure failed', { userId: user.id }, err)
    return fail(500, 'We read the text but could not organise it.')
  }
  const warnings = [...result.warnings, ...structureWarnings]
  setTraceOutput({ format: result.format, method: result.method, warnings: warnings.length })

  const method = resume.meta.cello.structuredBy === 'llm' ? 'Structured with AI' : result.method
  const base = {
    success: true,
    message: `Resume imported from ${result.format.toUpperCase()} · ${method}`,
    // `extractionMethod` and `wordCount` are the field names the settings card
    // already renders; kept.
    extractionMethod: method,
    wordCount: result.plainText.split(/\s+/).filter(Boolean).length,
    format: result.format,
    structurePreserved: result.structurePreserved,
    warnings,
    resume,
  }

  // A picture or scan is reviewed before it replaces anything.
  if (!parsed.persist) return NextResponse.json({ ...base, documentId: null, version: null })

  try {
    // Keep whatever template this user already chose for their base resume:
    // re-uploading a resume is not a request to restyle it.
    const previous = await getBaseResume(budgetAdmin, user.id)
    resume.meta.cello.templateId = getResumeTemplateId(previous?.content_json) ?? DEFAULT_TEMPLATE_ID
    const document = await createResumeVersion(budgetAdmin, {
      userId: user.id,
      jobId: null,
      title: titleFromFilename(parsed.file?.filename ?? null),
      resume,
      source: 'base',
    })
    return NextResponse.json({ ...base, documentId: document.id, version: document.version })
  } catch (err) {
    console.error('[resume/upload] save failed', { userId: user.id }, err)
    return fail(500, 'Failed to save resume')
  }
}
