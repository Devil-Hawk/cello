// resume -> markdown -> plain text. The one renderer: every resume has the same
// shape whatever its origin, because nothing authors Markdown by hand.
//
// Fixed heading levels: `#` name, `##` section, `###` entry. The templates
// already style h1/h2/h3, so every section gets the template's section style.

import { escapeInlineMarkdown } from './import/infer'
import { markdownToPlainText } from './markdown'
import type { Resume } from './schema'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2021-03" -> "Mar 2021", "2021" -> "2021". */
export function formatPartialDate(d: string | undefined): string {
  if (!d) return ''
  const m = /^(\d{4})-(\d{2})$/.exec(d)
  return m ? `${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : d
}

interface DatedEntry {
  startDate?: string
  endDate?: string
  current?: boolean
  dateLabel?: string
}

/** dateLabel verbatim; "Mar 2021 - Jun 2023"; "Mar 2021 - Present" only when `current`; a lone date alone. */
export function formatDates(e: DatedEntry): string {
  if (e.dateLabel?.trim()) return e.dateLabel.trim()
  const start = formatPartialDate(e.startDate)
  const end = e.current ? 'Present' : formatPartialDate(e.endDate)
  if (start && end) return `${start} - ${end}`
  return start || end
}

const esc = escapeInlineMarkdown
/** Free text is paragraphs: a lone newline is a soft wrap (it would print as a hard break in the PDF), a blank line is a paragraph break. */
const prose = (s: string): string => esc(s.trim().replace(/[ \t]*\n(?:[ \t]*\n)+[ \t]*/g, '\n\n').replace(/(?<!\n)[ \t]*\n[ \t]*(?!\n)/g, ' '))
const join = (parts: Array<string | undefined>, sep: string): string =>
  parts.map((p) => p?.trim()).filter(Boolean).join(sep)

export function formatLocation(loc: Resume['basics']['location']): string {
  return join([loc?.city, loc?.region, loc?.countryCode], ', ')
}

export const DEFAULT_SECTION_ORDER = [
  'summary',
  'work',
  'projects',
  'skills',
  'education',
  'certificates',
  'awards',
  'languages',
  'custom',
] as const

type Block = string[]

function bullets(items: string[]): string[] {
  return items.filter((i) => i.trim()).map((i) => `- ${esc(i.trim())}`)
}

function entryMeta(parts: Array<string | undefined>): string[] {
  const line = join(parts, ' | ')
  return line ? [`*${esc(line)}*`] : []
}

function sectionBlocks(resume: Resume): Record<string, Block[]> {
  const out: Record<string, Block[]> = {}
  const { basics } = resume

  if (basics.summary?.trim()) out.summary = [[prose(basics.summary)]]

  out.work = resume.work.map((w) => [
    `### ${esc(join([w.position, w.name], ', '))}`,
    ...entryMeta([w.location, formatDates(w)]),
    ...(w.summary?.trim() ? ['', prose(w.summary)] : []),
    ...(w.highlights.length ? ['', ...bullets(w.highlights)] : []),
  ])

  out.projects = resume.projects.map((p) => [
    `### ${esc(p.name)}`,
    ...entryMeta([p.url, formatDates(p)]),
    ...(p.description?.trim() ? ['', prose(p.description)] : []),
    ...(p.highlights.length ? ['', ...bullets(p.highlights)] : []),
  ])

  if (resume.skills.length) {
    out.skills = [
      // One group per line. A bare newline is a soft break that the HTML preview
      // folds into a space, so each line but the last ends in a hard break (two trailing spaces,
      // which the editor does not show).
      resume.skills.map((s, i, all) => {
        const kw = esc(s.keywords.join(', '))
        const line = s.name.trim() ? `**${esc(s.name.trim())}:** ${kw}` : kw
        return i < all.length - 1 ? `${line}  ` : line
      }),
    ]
  }

  out.education = resume.education.map((e) => [
    `### ${esc(join([join([e.studyType, e.area], ' '), e.institution], ', '))}`,
    ...entryMeta([e.location, formatDates(e), e.score ? `GPA ${e.score}` : undefined]),
    ...(e.courses.length ? ['', ...bullets(e.courses)] : []),
  ])

  if (resume.certificates.length) {
    out.certificates = [
      bullets(
        resume.certificates.map((c) =>
          join([c.name, c.issuer, c.dateLabel ?? formatPartialDate(c.date)], ' | ')
        )
      ),
    ]
  }
  if (resume.awards.length) {
    out.awards = [
      bullets(
        resume.awards.map((a) =>
          join([a.title, a.awarder, a.dateLabel ?? formatPartialDate(a.date), a.summary], ' | ')
        )
      ),
    ]
  }
  if (resume.languages.length) {
    out.languages = [
      bullets(resume.languages.map((l) => (l.fluency ? `${l.language} (${l.fluency})` : l.language))),
    ]
  }
  return out
}

const TITLES: Record<string, string> = {
  summary: 'Summary',
  work: 'Experience',
  projects: 'Projects',
  skills: 'Skills',
  education: 'Education',
  certificates: 'Certifications',
  awards: 'Awards',
  languages: 'Languages',
}

/** Section order: meta.cello.sectionOrder, then the default order for anything it leaves out. */
function orderedKeys(resume: Resume): string[] {
  const requested = resume.meta.cello.sectionOrder ?? []
  const known = new Set<string>(DEFAULT_SECTION_ORDER)
  const keys = [...requested.filter((k) => known.has(k))]
  for (const k of DEFAULT_SECTION_ORDER) if (!keys.includes(k)) keys.push(k)
  return keys
}

export function resumeToMarkdown(resume: Resume): string {
  const { basics } = resume
  const head: string[] = [`# ${esc(basics.name)}`]
  if (basics.label?.trim()) head.push(esc(basics.label.trim()))
  const contact = join(
    [
      basics.email,
      basics.phone,
      formatLocation(basics.location),
      basics.url,
      ...basics.profiles.map((p) => p.url ?? (p.username ? `${p.network}: ${p.username}` : p.network)),
    ],
    ' | '
  )
  if (contact) head.push(esc(contact))

  const chunks: string[] = [head.join('\n')]
  const blocks = sectionBlocks(resume)

  for (const key of orderedKeys(resume)) {
    if (key === 'custom') {
      for (const c of resume.meta.cello.customSections) {
        if (!c.title.trim() || c.items.every((i) => !i.trim())) continue
        chunks.push(`## ${esc(c.title.trim())}`, bullets(c.items).join('\n'))
      }
      continue
    }
    const entries = (blocks[key] ?? []).filter((b) => b.length > 0)
    if (entries.length === 0) continue
    chunks.push(`## ${TITLES[key]}`)
    if (key === 'work' || key === 'projects' || key === 'education') {
      for (const entry of entries) chunks.push(entry.join('\n'))
    } else {
      chunks.push(entries[0].join('\n'))
    }
  }
  return chunks.join('\n\n') + '\n'
}

/** The ATS text: one line over the tested Markdown -> plain text path. */
export function resumeToPlainText(resume: Resume): string {
  return markdownToPlainText(resumeToMarkdown(resume))
}

/**
 * User-authored strings only: no normalised dates, no "Present", no section
 * titles. The faithfulness gates and the word-bag test read this, so renderer
 * vocabulary is never mistaken for an invented fact.
 */
export function resumeFactText(resume: Resume): string {
  const b = resume.basics
  const out: Array<string | undefined> = [
    b.name,
    b.label,
    b.email,
    b.phone,
    b.url,
    b.location?.city,
    b.location?.region,
    b.location?.countryCode,
    // A network name is derived from its URL, so it is a fact only when it is all there is.
    ...b.profiles.flatMap((p) => (p.url || p.username ? [p.url, p.username] : [p.network])),
    b.summary,
  ]
  for (const w of resume.work) out.push(w.name, w.position, w.location, w.url, w.dateLabel, w.summary, ...w.highlights)
  for (const e of resume.education) {
    out.push(e.institution, e.studyType, e.area, e.location, e.dateLabel, e.score, ...e.courses)
  }
  for (const s of resume.skills) out.push(s.name, ...s.keywords)
  for (const p of resume.projects) out.push(p.name, p.description, p.url, p.dateLabel, ...p.highlights)
  for (const c of resume.certificates) out.push(c.name, c.issuer, c.dateLabel, c.url)
  for (const a of resume.awards) out.push(a.title, a.awarder, a.dateLabel, a.summary)
  for (const l of resume.languages) out.push(l.language, l.fluency)
  for (const c of resume.meta.cello.customSections) out.push(c.title, ...c.items)
  return out.filter((s): s is string => Boolean(s?.trim())).join('\n')
}
