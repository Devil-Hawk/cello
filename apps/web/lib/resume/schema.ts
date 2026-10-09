// The one resume structure. A hand-owned subset of JSON Resume v1.0.0
// (https://jsonresume.org/schema) validated by Zod. `content_json.resume` holds
// one of these and is the ONLY thing anything authors; markdown, plain text and
// profiles.resume_text are all derived from it (see render.ts and store.ts).
//
// Two extension fields, `current` and `dateLabel`, are allowed by JSON Resume's
// additionalProperties: true. "Present" prints only when `current` is true: a
// missing endDate never means Present.

import { z } from 'zod'

const PartialDate = z.string().regex(/^\d{4}(-\d{2})?$/, 'Use 2021 or 2021-03')
const Str = z.string().trim()

const dates = {
  startDate: PartialDate.optional(),
  endDate: PartialDate.optional(),
  /** The source said Present / Current / Now / Today. Nothing else sets it. */
  current: z.boolean().default(false),
  /** The original text when it will not normalise ("Summer 2019"). Printed verbatim. */
  dateLabel: Str.optional(),
}

export const ResumeSchema = z.object({
  basics: z.object({
    name: Str.min(1),
    label: Str.optional(),
    email: Str.optional(),
    phone: Str.optional(),
    url: Str.optional(),
    location: z
      .object({ city: Str.optional(), region: Str.optional(), countryCode: Str.optional() })
      .optional(),
    profiles: z.array(z.object({ network: Str, url: Str.optional(), username: Str.optional() })).default([]),
    summary: Str.optional(),
  }),
  work: z
    .array(
      z.object({
        name: Str,
        position: Str,
        location: Str.optional(),
        url: Str.optional(),
        ...dates,
        summary: Str.optional(),
        highlights: z.array(Str).default([]),
      })
    )
    .default([]),
  education: z
    .array(
      z.object({
        institution: Str,
        area: Str.optional(),
        studyType: Str.optional(),
        location: Str.optional(),
        ...dates,
        score: Str.optional(),
        courses: z.array(Str).default([]),
      })
    )
    .default([]),
  skills: z.array(z.object({ name: Str, keywords: z.array(Str).default([]) })).default([]),
  projects: z
    .array(
      z.object({
        name: Str,
        description: Str.optional(),
        url: Str.optional(),
        ...dates,
        highlights: z.array(Str).default([]),
      })
    )
    .default([]),
  certificates: z
    .array(
      z.object({
        name: Str,
        issuer: Str.optional(),
        date: PartialDate.optional(),
        dateLabel: Str.optional(),
        url: Str.optional(),
      })
    )
    .default([]),
  awards: z
    .array(
      z.object({
        title: Str,
        awarder: Str.optional(),
        date: PartialDate.optional(),
        dateLabel: Str.optional(),
        summary: Str.optional(),
      })
    )
    .default([]),
  languages: z.array(z.object({ language: Str, fluency: Str.optional() })).default([]),
  meta: z
    .object({
      cello: z
        .object({
          templateId: Str.optional(),
          sectionOrder: z.array(Str).optional(),
          /** Anything the schema has no slot for. Content is never dropped. */
          customSections: z.array(z.object({ title: Str, items: z.array(Str) })).default([]),
          parsedFrom: z
            .enum(['paste', 'txt', 'md', 'pdf', 'docx', 'image', 'scan', 'legacy', 'demo'])
            .optional(),
          structuredBy: z.enum(['llm', 'heuristic', 'editor', 'tailor']).optional(),
          warnings: z.array(Str).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
})

export type Resume = z.infer<typeof ResumeSchema>
export type ParsedFrom = NonNullable<Resume['meta']['cello']['parsedFrom']>

// ---------------------------------------------------------------------------
// One lenient date parser
// ---------------------------------------------------------------------------

export type PartialDateString = string

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]
const OPEN_END_RE = /^(?:present|current|now|today)$/i

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fullYear(y: string): string {
  if (y.length === 4) return y
  const n = Number(y)
  return String(n >= 50 ? 1900 + n : 2000 + n)
}

/**
 * "Mar 2021", "March 2021", "03/2021", "3/2021", "2021-03" and "2021" parse.
 * Present / Current / Now / Today give `current`. Anything else is a `label`,
 * so a date can never fail validation and block a save.
 */
export function parseLooseDate(text: string): { date?: PartialDateString; current?: true; label?: string } {
  const t = text.trim().replace(/[.,;]+$/, '').trim()
  if (!t) return {}
  if (OPEN_END_RE.test(t)) return { current: true }
  let m = /^(\d{4})-(\d{1,2})$/.exec(t)
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { date: `${m[1]}-${pad(Number(m[2]))}` }
  m = /^(\d{1,2})\/(\d{4})$/.exec(t)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { date: `${m[2]}-${pad(Number(m[1]))}` }
  m = /^([A-Za-z]{3,9})\.?,?\s*['’]?(\d{4}|\d{2})$/.exec(t)
  if (m) {
    const word = m[1].toLowerCase()
    const idx = word === 'sept' ? 8 : MONTHS.indexOf(word.slice(0, 3))
    if (idx >= 0 && (word.length === 3 || word === 'sept' || MONTH_FULL[idx] === word)) {
      return { date: `${fullYear(m[2])}-${pad(idx + 1)}` }
    }
  }
  m = /^(\d{4})$/.exec(t)
  if (m) return { date: m[1] }
  return { label: t }
}

// A hyphen splits a range only between a year and a year/month/open end, so
// "2021-03" stays one date and "2019-2023" and "Mar 2019-Present" split.
// No lookbehind: this file reaches browsers through the resume pages, and a lookbehind is a parse error
// on Safari before 16.4. The hyphen after a year is first given spaces, then every range splits the same way.
const RANGE_SPLIT = /\s*(?:\u2013|\u2014|\u2192|\bto\b|\bthrough\b|\buntil\b)\s*|\s+-\s+/i
const YEAR_HYPHEN = /(\d{4})\s*-\s*(?=\d{4}|\d{1,2}\/|[A-Za-z])/g

export interface ParsedRange {
  startDate?: PartialDateString
  endDate?: PartialDateString
  current?: true
  dateLabel?: string
  /** A lone date, left for the caller to place by section type. */
  single?: PartialDateString
}

export function parseDateRange(text: string): ParsedRange {
  const t = text.trim()
  if (!t) return {}
  const parts = t.replace(YEAR_HYPHEN, '$1 - ').split(RANGE_SPLIT).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 1) {
    const one = parseLooseDate(parts[0])
    if (one.date) return { single: one.date }
    // A lone "Present" is not a range: keep the words.
    return { dateLabel: t }
  }
  if (parts.length === 2) {
    const a = parseLooseDate(parts[0])
    const b = parseLooseDate(parts[1])
    if (a.date && (b.date || b.current)) {
      return b.current ? { startDate: a.date, current: true } : { startDate: a.date, endDate: b.date }
    }
  }
  return { dateLabel: t }
}

export type DateKind = 'work' | 'education'

/** Fold a parsed range into an entry's date fields, placing a lone date by section type. */
export function datesFor(text: string, kind: DateKind): {
  startDate?: string
  endDate?: string
  current: boolean
  dateLabel?: string
} {
  const r = parseDateRange(text)
  if (r.single) {
    return kind === 'education'
      ? { endDate: r.single, current: false }
      : { startDate: r.single, current: false }
  }
  return {
    startDate: r.startDate,
    endDate: r.endDate,
    current: r.current === true,
    dateLabel: r.dateLabel,
  }
}

// ---------------------------------------------------------------------------
// Name fallback chain (the part not in the source text)
// ---------------------------------------------------------------------------

export interface NameContext {
  fullName?: string | null
  email?: string | null
}

export const NAME_WARNING = 'We could not find your name; check it before sending'

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase())
}

/** profile name, then the email local part, then "Your Name". Always warn. */
export function fallbackName(ctx?: NameContext): string {
  const full = ctx?.fullName?.trim()
  if (full) return full
  const local = ctx?.email?.split('@')[0]?.replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim()
  if (local) return titleCase(local.toLowerCase())
  return 'Your Name'
}

// ---------------------------------------------------------------------------
// LLM-facing schemas: small, strict, every field required
// ---------------------------------------------------------------------------

const S = z.string()
export const ResumeLlmSchema = z.object({
  basics: z.object({
    name: S,
    label: S,
    email: S,
    phone: S,
    url: S,
    location: S,
    summary: S,
  }),
  work: z.array(
    z.object({ name: S, position: S, location: S, dates: S, summary: S, highlights: z.array(S) })
  ),
  education: z.array(
    z.object({ institution: S, studyType: S, area: S, location: S, dates: S, courses: z.array(S) })
  ),
  skills: z.array(z.object({ name: S, keywords: z.array(S) })),
  projects: z.array(z.object({ name: S, description: S, url: S, dates: S, highlights: z.array(S) })),
  certificates: z.array(z.object({ name: S, issuer: S, dates: S })),
  customSections: z.array(z.object({ title: S, items: z.array(S) })),
})
export type ResumeLlm = z.infer<typeof ResumeLlmSchema>

export const TailorPatchSchema = z.object({
  summary: S,
  skills: z.array(z.object({ name: S, keywords: z.array(S) })),
  work: z.array(z.object({ index: z.number().int(), highlights: z.array(S) })),
  projects: z.array(z.object({ index: z.number().int(), highlights: z.array(S) })),
})
export type TailorPatch = z.infer<typeof TailorPatchSchema>

/** JSON Schema for strict structured output (every property required, closed objects). */
export function llmJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
}

const opt = (s: string | undefined): string | undefined => {
  const v = s?.trim()
  return v ? v : undefined
}

function splitLocation(text: string | undefined): Resume['basics']['location'] {
  const t = opt(text)
  if (!t) return undefined
  const i = t.indexOf(',')
  if (i < 0) return { city: t }
  return { city: t.slice(0, i).trim(), region: t.slice(i + 1).trim() || undefined }
}

/** Code, not prompt: dates parsed, empties dropped, name chain applied, then Zod. */
export function normalizeLlmResume(
  llm: ResumeLlm,
  ctx?: NameContext & { parsedFrom?: ParsedFrom; warnings?: string[] }
): Resume {
  const warnings = [...(ctx?.warnings ?? [])]
  let name = opt(llm.basics.name)
  if (!name) {
    name = fallbackName(ctx)
    warnings.push(NAME_WARNING)
  }
  const list = (a: string[]) => a.map((s) => s.trim()).filter(Boolean)
  const draft = {
    basics: {
      name,
      label: opt(llm.basics.label),
      email: opt(llm.basics.email),
      phone: opt(llm.basics.phone),
      url: opt(llm.basics.url),
      location: splitLocation(llm.basics.location),
      summary: opt(llm.basics.summary),
    },
    work: llm.work
      .filter((w) => w.name.trim() || w.position.trim())
      .map((w) => ({
        name: w.name.trim(),
        position: w.position.trim(),
        location: opt(w.location),
        ...datesFor(w.dates, 'work'),
        summary: opt(w.summary),
        highlights: list(w.highlights),
      })),
    education: llm.education
      .filter((e) => e.institution.trim() || e.area.trim() || e.studyType.trim())
      .map((e) => ({
        institution: e.institution.trim(),
        studyType: opt(e.studyType),
        area: opt(e.area),
        location: opt(e.location),
        ...datesFor(e.dates, 'education'),
        courses: list(e.courses),
      })),
    skills: llm.skills
      .filter((s) => list(s.keywords).length > 0)
      .map((s) => ({ name: s.name.trim() || 'Skills', keywords: list(s.keywords) })),
    projects: llm.projects
      .filter((p) => p.name.trim())
      .map((p) => ({
        name: p.name.trim(),
        description: opt(p.description),
        url: opt(p.url),
        ...datesFor(p.dates, 'work'),
        highlights: list(p.highlights),
      })),
    certificates: llm.certificates
      .filter((c) => c.name.trim())
      .map((c) => {
        const r = parseDateRange(c.dates)
        return {
          name: c.name.trim(),
          issuer: opt(c.issuer),
          date: r.single,
          dateLabel: r.dateLabel,
        }
      }),
    meta: {
      cello: {
        parsedFrom: ctx?.parsedFrom,
        structuredBy: 'llm' as const,
        warnings,
        customSections: llm.customSections
          .filter((c) => c.title.trim() && list(c.items).length > 0)
          .map((c) => ({ title: c.title.trim(), items: list(c.items) })),
      },
    },
  }
  return ResumeSchema.parse(draft)
}
