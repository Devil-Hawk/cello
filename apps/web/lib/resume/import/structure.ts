// Text -> a valid Resume. Every input (paste, .txt, .md, .docx, text PDF, and a
// transcribed photo or scan) ends here and comes out as a Resume that passes
// ResumeSchema, by construction:
//
//   LLM (strict json_schema) -> Zod -> one re-ask -> faithfulness gate
//   anything fails, or there is no LLM -> markdownToResume() (deterministic)
//
// The faithfulness gate reads resumeFactText(), the user-authored strings
// only, so renderer vocabulary ("Mar", "Present", section titles) is never
// mistaken for an invented fact. A date's year must also appear in the source,
// and the answer must keep 85% of the source's distinct words (no dropped sections).

import { parseJsonLoose } from '@/lib/harness/llm'
import type { LlmRunOptions } from '@/lib/harness/types'
import { markdownToResume } from '../from-markdown'
import { resumeFactText, resumeToPlainText } from '../render'
import {
  NAME_WARNING,
  ResumeLlmSchema,
  llmJsonSchema,
  normalizeLlmResume,
  type NameContext,
  type ParsedFrom,
  type Resume,
} from '../schema'
import { MIN_RETENTION, findInventedFacts, wordRetention } from './llm'
import { COLUMNS_WARNING, looksLikeColumns } from './infer'

export type StructureRunner = (opts: LlmRunOptions) => Promise<{ content: string }>

export interface StructureOptions {
  run?: StructureRunner | null
  nameCtx?: NameContext
  parsedFrom?: ParsedFrom
  /** Abort budget for the LLM leg. */
  timeoutMs?: number
}

export const HEURISTIC_WARNING = 'Structured automatically; check the sections'

const SYSTEM = `You turn resume text into structured JSON. You are EXTRACTING, not writing.

RULES
- Copy wording exactly. Do NOT invent, embellish, summarise, reword or reorder anything.
- Never add an employer, title, date, school, skill, metric or achievement that is not in the text.
- Every field is required. Use "" or [] when the text does not say.
- "dates" is the date text as written ("Mar 2021 - Present", "2016", "Summer 2019"). Copy it as is.
- One entry per job, school, project or certificate. Bullets go in "highlights" (or "courses" for education), one per bullet, without the bullet glyph.
- Skills: one group per label ("Languages: Go, SQL" is name "Languages", keywords ["Go","SQL"]). With no label, use name "Skills".
- Anything that fits no field (volunteering, publications, interests) goes in customSections with its own title, one item per line.
- Do not include the candidate's name inside any other field.`

const PROMPT_LIMIT = 24000

function years(text: string): string[] {
  return text.match(/\b(?:19|20)\d{2}\b/g) ?? []
}

function datesInResume(r: Resume): string[] {
  const out: Array<string | undefined> = []
  for (const w of [...r.work, ...r.projects]) out.push(w.startDate, w.endDate)
  for (const e of r.education) out.push(e.startDate, e.endDate)
  for (const c of r.certificates) out.push(c.date)
  for (const a of r.awards) out.push(a.date)
  return out.filter((d): d is string => Boolean(d))
}

async function ask(
  run: StructureRunner,
  markdown: string,
  extra: string | null,
  timeoutMs: number
): Promise<unknown> {
  const prompt =
    `RESUME TEXT:\n${markdown.slice(0, PROMPT_LIMIT)}` +
    (extra ? `\n\nYour previous answer was invalid: ${extra}\nReturn the corrected JSON.` : '')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('structure timed out')), timeoutMs)
  })
  const call = run({
      system: SYSTEM,
      prompt,
      json: true,
      jsonSchema: { name: 'resume', schema: llmJsonSchema(ResumeLlmSchema) },
      temperature: 0,
      maxTokens: 8000,
    })
  try {
    const { content } = await Promise.race([call, timedOut])
    try {
      return parseJsonLoose(content)
    } catch {
      // Not JSON: let the schema check report it, so it gets the one re-ask.
      return undefined
    }
  } finally {
    clearTimeout(timer)
  }
}

function issuePaths(err: { issues?: Array<{ path: PropertyKey[]; message: string }> }): string {
  return (err.issues ?? [])
    .slice(0, 12)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

/** Returns a faithful Resume from the LLM, or null on any failure. */
async function viaLlm(
  markdown: string,
  sourceText: string,
  opts: StructureOptions
): Promise<{ resume: Resume } | { reason: string }> {
  const run = opts.run!
  const timeoutMs = opts.timeoutMs ?? 40_000
  let extra: string | null = null
  let resume: Resume | null = null

  for (let attempt = 0; attempt < 2 && !resume; attempt++) {
    try {
      const raw = await ask(run, markdown, extra, timeoutMs)
      const parsed = ResumeLlmSchema.safeParse(raw)
      if (!parsed.success) {
        extra = issuePaths(parsed.error)
        continue
      }
      resume = normalizeLlmResume(parsed.data, { ...opts.nameCtx, parsedFrom: opts.parsedFrom })
    } catch (err) {
      const e = err as { issues?: Array<{ path: PropertyKey[]; message: string }> }
      if (e.issues) {
        extra = issuePaths(e)
        continue
      }
      return { reason: err instanceof Error ? err.message : 'the AI call failed' }
    }
  }
  if (!resume) return { reason: 'the AI answer did not match the resume format' }

  // Faithfulness. The fallback name is not from the source, so it is excluded.
  const usedFallbackName = resume.meta.cello.warnings.includes(NAME_WARNING)
  const facts = resumeFactText(
    usedFallbackName ? { ...resume, basics: { ...resume.basics, name: ' ' } } : resume
  )
  const invented = findInventedFacts(sourceText, facts)
  if (invented.length > 0) {
    return { reason: `it added details that are not in your text (${invented.slice(0, 3).join(', ')})` }
  }
  const sourceYears = new Set(years(sourceText))
  const missingYear = datesInResume(resume)
    .map((d) => d.slice(0, 4))
    .find((y) => !sourceYears.has(y))
  if (missingYear) return { reason: `it used a year that is not in your text (${missingYear})` }
  // Dropped content. An answer that omits sections (or was cut by the prompt or
  // token limit) is faithful to what it kept, so the gates above pass it.
  const retention = wordRetention(sourceText, resumeToPlainText(resume))
  if (retention !== null && retention < MIN_RETENTION) {
    return { reason: `it left out too much of your text (kept ${Math.round(retention * 100)}%)` }
  }
  return { resume }
}

/** Keeps the columns warning on the resume, so Profile can list it as a format fix. */
function withColumns(resume: Resume, sourceText: string): { resume: Resume; warnings: string[] } {
  if (looksLikeColumns(sourceText)) resume.meta.cello.warnings.push(COLUMNS_WARNING)
  return { resume, warnings: resume.meta.cello.warnings }
}

export async function structureResume(
  markdown: string,
  sourceText: string,
  opts: StructureOptions = {}
): Promise<{ resume: Resume; warnings: string[] }> {
  if (opts.run) {
    const out = await viaLlm(markdown, sourceText, opts)
    if ('resume' in out) return withColumns(out.resume, sourceText)
    console.error('[resume/structure] LLM leg discarded:', out.reason)
  }
  const resume = markdownToResume(markdown, { ...opts.nameCtx, parsedFrom: opts.parsedFrom })
  resume.meta.cello.warnings.push(HEURISTIC_WARNING)
  return withColumns(resume, sourceText)
}
