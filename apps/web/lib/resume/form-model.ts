// The editing rules behind components/resume/resume-form.tsx, kept pure so they
// can be tested without a DOM. The form edits a Resume directly: nothing here
// knows about Markdown, and the preview, the diff and the save all derive from
// the same cleaned Resume.

import { orderedKeys, formatDates, resumeToMarkdown } from './render'
import { ResumeSchema, datesFor, parseDateRange, type Resume } from './schema'

export type SectionKey = 'summary' | 'work' | 'projects' | 'skills' | 'education' | 'certificates' | 'awards' | 'languages' | 'custom'

export const SECTION_TITLES: Record<SectionKey, string> = {
  summary: 'Summary',
  work: 'Experience',
  projects: 'Projects',
  skills: 'Skills',
  education: 'Education',
  certificates: 'Certifications',
  awards: 'Awards',
  languages: 'Languages',
  custom: 'Other sections',
}

export function sectionKeys(resume: Resume): SectionKey[] {
  return orderedKeys(resume) as SectionKey[]
}

/** Swap a section with its neighbour. The order is written out in full, so it survives a save. */
export function moveSection(resume: Resume, key: SectionKey, dir: -1 | 1): Resume {
  const keys = sectionKeys(resume)
  const to = keys.indexOf(key) + dir
  if (to < 0 || to >= keys.length) return resume
  const next = [...keys]
  ;[next[to], next[to - dir]] = [next[to - dir], next[to]]
  return { ...resume, meta: { ...resume.meta, cello: { ...resume.meta.cello, sectionOrder: next } } }
}

export function moveItem<T>(items: T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return items
  const next = [...items]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

export function duplicateItem<T>(items: T[], index: number): T[] {
  if (index < 0 || index >= items.length) return items
  const next = [...items]
  next.splice(index + 1, 0, structuredClone(items[index]))
  return next
}

export function removeItem<T>(items: T[], index: number): T[] {
  return items.filter((_, i) => i !== index)
}

// ---------------------------------------------------------------------------
// Dates: free text in, structure out. Nothing here can fail, so a date can
// never block a save.
// ---------------------------------------------------------------------------

interface Dated {
  startDate?: string
  endDate?: string
  current: boolean
  dateLabel?: string
}

/** What the date field shows: the original label, or the normalised range. */
export function dateText(entry: Dated): string {
  return formatDates(entry)
}

/** Parse what was typed. Blank clears; a lone date is placed by section type; anything else is kept as typed. */
export function withDateText<T extends Dated>(entry: T, text: string, kind: 'work' | 'education'): T {
  // The old values are cleared first: datesFor leaves out what it did not find,
  // and a stale dateLabel would otherwise keep printing over the new date.
  return { ...entry, startDate: undefined, endDate: undefined, dateLabel: undefined, ...datesFor(text, kind) }
}

/** Current sets `current` and clears the end; unticking just stops printing "Present". */
export function withCurrent<T extends Dated>(entry: T, on: boolean): T {
  return on
    ? { ...entry, current: true, endDate: undefined, dateLabel: undefined }
    : { ...entry, current: false }
}

/** Certificates and awards carry one date. */
export function withSingleDate<T extends { date?: string; dateLabel?: string }>(entry: T, text: string): T {
  const r = parseDateRange(text)
  return { ...entry, date: r.single, dateLabel: r.single ? undefined : r.dateLabel }
}

export function singleDateText(entry: { date?: string; dateLabel?: string }): string {
  return formatDates({ startDate: entry.date, current: false, dateLabel: entry.dateLabel })
}

// ---------------------------------------------------------------------------
// Cleaning and validation
// ---------------------------------------------------------------------------

const blank = (s: string | undefined | null): boolean => !s || !s.trim()
const allBlank = (...parts: Array<string | undefined | null>): boolean => parts.every(blank)
const lines = (items: string[]): string[] => items.filter((i) => !blank(i))
const hasDates = (e: Dated): boolean => !blank(e.startDate) || !blank(e.endDate) || e.current || !blank(e.dateLabel)

/** An empty card is dropped rather than failing: the form keeps blank cards so you can type into them. */
export function cleanResume(resume: Resume): Resume {
  const b = resume.basics
  return {
    ...resume,
    basics: {
      ...b,
      location: b.location && !allBlank(b.location.city, b.location.region, b.location.countryCode) ? b.location : undefined,
      profiles: b.profiles.filter((p) => !blank(p.network) || !blank(p.url)).map((p) => (blank(p.network) ? { ...p, network: p.url ?? '' } : p)),
    },
    work: resume.work
      .map((w) => ({ ...w, highlights: lines(w.highlights) }))
      .filter((w) => !(allBlank(w.name, w.position, w.location, w.url, w.summary) && w.highlights.length === 0 && !hasDates(w))),
    education: resume.education
      .map((e) => ({ ...e, courses: lines(e.courses) }))
      .filter((e) => !(allBlank(e.institution, e.area, e.studyType, e.location, e.score) && e.courses.length === 0 && !hasDates(e))),
    projects: resume.projects
      .map((p) => ({ ...p, highlights: lines(p.highlights) }))
      .filter((p) => !(allBlank(p.name, p.description, p.url) && p.highlights.length === 0 && !hasDates(p))),
    skills: resume.skills
      .map((s) => ({ ...s, keywords: lines(s.keywords) }))
      .filter((s) => s.keywords.length > 0),
    certificates: resume.certificates.filter((c) => !allBlank(c.name, c.issuer, c.dateLabel, c.date)),
    awards: resume.awards.filter((a) => !allBlank(a.title, a.awarder, a.summary, a.dateLabel, a.date)),
    languages: resume.languages.filter((l) => !blank(l.language)),
    meta: {
      ...resume.meta,
      cello: {
        ...resume.meta.cello,
        customSections: resume.meta.cello.customSections
          .map((c) => ({ ...c, items: lines(c.items) }))
          .filter((c) => !blank(c.title) || c.items.length > 0)
          .map((c) => (blank(c.title) ? { ...c, title: 'Other' } : c)),
      },
    },
  }
}

export interface FieldProblem {
  /** The DOM id of the field to focus. */
  id: string
  message: string
}

export const NAME_FIELD_ID = 'resume-field-name'

/** Only an empty name can fail: dates fall back to their text and empty cards are dropped. */
export function validateResume(resume: Resume): FieldProblem[] {
  const parsed = ResumeSchema.safeParse(cleanResume(resume))
  if (parsed.success) return []
  return [{ id: NAME_FIELD_ID, message: 'Add your name' }]
}

/** The resume as it will be saved, or null while something blocks a save. */
export function toSaveable(resume: Resume): Resume | null {
  const parsed = ResumeSchema.safeParse(cleanResume(resume))
  return parsed.success ? parsed.data : null
}

/** A stable string for "has this changed", insensitive to empty cards and stray spaces. */
export function fingerprint(resume: Resume): string {
  return JSON.stringify(toSaveable(resume) ?? cleanResume(resume))
}

/** The preview text. A blank name shows a placeholder instead of an empty heading. */
export function previewMarkdown(resume: Resume): string {
  const c = cleanResume(resume)
  return resumeToMarkdown(blank(c.basics.name) ? { ...c, basics: { ...c.basics, name: 'Your name' } } : c)
}

/** A resume with nothing in it, for an account that has none yet. */
export function emptyResume(): Resume {
  const r = ResumeSchema.parse({ basics: { name: 'x' } })
  r.basics.name = ''
  return r
}
