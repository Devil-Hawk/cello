// Deterministic Markdown -> Resume. It walks the same block model the PDF and
// the preview render, so it understands whatever the importers and the editor
// produce: `#`/`##`/`###` headings, bold role lines, italic meta lines, bullets.
//
// It is the no-LLM structurer, the legacy-row converter (resolve.ts) and the
// editor's save path. Every word of the input lands somewhere (the word-bag
// test holds it to that): nothing is dropped, and what has no slot goes to
// meta.cello.customSections.

import { inferResumeMarkdown, isKnownSectionTitle, isLikelyName } from './import/infer'
import {
  looksAuthoredInMarkdown,
  parseResumeMarkdown,
  type ResumeBlock,
  type ResumeInlineLine,
} from './markdown'
import {
  NAME_WARNING,
  ResumeSchema,
  datesFor,
  fallbackName,
  type NameContext,
  type ParsedFrom,
  type Resume,
} from './schema'

type Kind =
  | 'summary'
  | 'work'
  | 'education'
  | 'skills'
  | 'projects'
  | 'certificates'
  | 'awards'
  | 'languages'
  | 'custom'

function sectionKind(title: string): Kind {
  const t = title.toLowerCase()
  if (/volunteer|leadership|activit|affiliat|member|interest|hobb|reference|publication|patent|presentation|talk|speaking|contact|additional|achievement|accomplishment/.test(t)) return 'custom'
  if (/summary|profile|objective|about|qualification|highlights/.test(t)) return 'summary'
  if (/experience|employment|work history|career history/.test(t)) return 'work'
  if (/education|academic/.test(t)) return 'education'
  if (/skill|competenc|technolog|tools|expertise|proficienc/.test(t)) return 'skills'
  if (/project|portfolio/.test(t)) return 'projects'
  if (/certif|licen/.test(t)) return 'certificates'
  if (/award|honor/.test(t)) return 'awards'
  if (/^languages?$/.test(t)) return 'languages'
  return 'custom'
}

const text = (line: ResumeInlineLine): string => line.map((r) => r.text).join('')
const allBold = (line: ResumeInlineLine): boolean => line.length > 0 && line.every((r) => r.bold)
const allItalic = (line: ResumeInlineLine): boolean => line.length > 0 && line.every((r) => r.italic)

// --- dates inside a title or meta line --------------------------------------

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const PT = `(?:${MONTH}\\s*['\u2019]?\\d{2,4}|\\d{1,2}[/.]\\d{4}|\\d{4}-\\d{2}|(?:19|20)\\d{2})`
const END = `(?:${PT}|present|current|now|today|ongoing)`
const SEP = '\\s*(?:-|\u2013|\u2014|to|through|until|\u2192)\\s*'
const RANGE_RE = new RegExp(`\\(?\\b${PT}${SEP}${END}\\b\\)?`, 'i')
const TRAILING_YEAR_RE = /(?:^|[\s,|(\u2013\u2014-])\(?((?:19|20)\d{2})\)?$/

/** Pull one date range (or a trailing year) out of a title. */
function extractDates(title: string, single: boolean): { rest: string; dates?: string } {
  const m = RANGE_RE.exec(title)
  if (m) {
    const rest = (title.slice(0, m.index) + ' ' + title.slice(m.index + m[0].length)).trim()
    return { rest: tidyTitle(rest), dates: m[0].replace(/^\(|\)$/g, '') }
  }
  if (single) {
    const y = TRAILING_YEAR_RE.exec(title)
    if (y) return { rest: tidyTitle(title.slice(0, y.index)), dates: y[1] }
  }
  return { rest: tidyTitle(title) }
}

function tidyTitle(s: string): string {
  return s
    .replace(/\(\s*\)/g, '')
    .replace(/^[\s,|:;\u2013\u2014-]+/, '')
    .replace(/[\s,|:;\u2013\u2014(-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const TITLE_SPLIT = /\s+(?:\u2014|\u2013|\|)\s+|\s+-\s+|\s+at\s+|,\s+/

function splitTitle(title: string): [string, string] {
  const m = TITLE_SPLIT.exec(title)
  if (!m) return [title, '']
  return [title.slice(0, m.index).trim(), title.slice(m.index + m[0].length).trim()]
}

const DEGREE_ABBR = /^(B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|MBA|Ph\.?D\.?|A\.?A\.?S?\.?|A\.?S\.?|BSc|MSc|B\.?Eng\.?|M\.?Eng\.?|BBA|JD|MD)\s+(.+)$/i
const DEGREE_LONG = /^((?:Bachelor|Master|Doctor|Associate)(?:'s|\u2019s)?(?: of [A-Za-z ]+?)?)(?:\s+in\s+|\s+of\s+)(.+)$/i

function splitDegree(text: string): { studyType?: string; area?: string } {
  const long = DEGREE_LONG.exec(text)
  if (long) return { studyType: long[1].trim(), area: long[2].trim() }
  const abbr = DEGREE_ABBR.exec(text)
  if (abbr) return { studyType: abbr[1], area: abbr[2].trim() }
  return text ? { area: text } : {}
}

const dateish = (s: string): boolean =>
  /(?:19|20)\d{2}|\b(?:present|current|now|today|ongoing)\b/i.test(s)

// --- the draft --------------------------------------------------------------

interface Draft {
  work: Resume['work']
  education: Resume['education']
  skills: Resume['skills']
  projects: Resume['projects']
  certificates: Resume['certificates']
  awards: Resume['awards']
  languages: Resume['languages']
  custom: Array<{ title: string; items: string[] }>
  summary: string[]
}

type Entry = Resume['work'][number] | Resume['education'][number] | Resume['projects'][number]

function splitKeywords(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /[,;\u2022\u00b7|]/.test(ch)) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parseSkillLine(line: ResumeInlineLine): { name: string; keywords: string[] } {
  const full = text(line).trim()
  const first = line[0]
  if (first?.bold && line.length > 1) {
    const name = first.text.replace(/:\s*$/, '').trim()
    const rest = line.slice(1).map((r) => r.text).join('').replace(/^\s*:?\s*/, '')
    if (name) return { name, keywords: splitKeywords(rest) }
  }
  const m = /^([^:]{1,40}):\s*(.+)$/.exec(full)
  if (m) return { name: m[1].trim(), keywords: splitKeywords(m[2]) }
  return { name: '', keywords: splitKeywords(full) }
}

// --- header -----------------------------------------------------------------

const EMAIL_RE = /^(?:mailto:)?[^\s@|]+@[^\s@|]+\.[^\s@|]+$/i
const URL_RE = /^(?:https?:\/\/|www\.)\S+$|^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i
const NETWORKS: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'github.com': 'GitHub',
  'twitter.com': 'Twitter',
  'x.com': 'X',
  'gitlab.com': 'GitLab',
}
const LOCATION_HINT = /,\s*[A-Z]{2}\b|,\s*(?:USA|US|UK|Canada|India|Germany|France)\b|\bremote\b/i
const TOKEN_SPLIT = /\s*(?:\||\u00b7|\u2022|\s\u2014\s|\s\u2013\s)\s*/

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length
}

function isPhone(s: string): boolean {
  return /^\+?[\d\s().-]{7,}$/.test(s) && digitCount(s) >= 7
}

function parseLocation(t: string): Resume['basics']['location'] {
  const i = t.indexOf(',')
  if (i < 0) return { city: t }
  return { city: t.slice(0, i).trim(), region: t.slice(i + 1).trim() || undefined }
}

// --- main -------------------------------------------------------------------

export interface MarkdownToResumeContext extends NameContext {
  parsedFrom?: ParsedFrom
}

/**
 * Text that may or may not be Markdown (the editor's buffer, a legacy row, a
 * paste): real Markdown is read as written, plain text gets its structure
 * inferred first, so a pasted resume is never read as one long paragraph.
 */
export function textToResume(text: string, ctx: MarkdownToResumeContext = {}): Resume {
  return markdownToResume(looksAuthoredInMarkdown(text) ? text : inferResumeMarkdown(text), ctx)
}

export function markdownToResume(markdown: string, ctx: MarkdownToResumeContext = {}): Resume {
  const blocks = parseResumeMarkdown(markdown)
  const warnings: string[] = []

  // The level the document uses for sections: where its known titles sit
  // (DOCX Heading 1 gives `# Summary`; everything else uses `##`). Unknown
  // headings deeper than that are entries, not sections.
  const knownLevel = blocks.reduce(
    (min, b) =>
      b.type === 'heading' && isKnownSectionTitle(text(b.lines[0])) ? Math.min(min, b.level) : min,
    Infinity
  )
  const sectionLevel = Number.isFinite(knownLevel) ? knownLevel : 2

  const isOpener = (i: number): boolean => {
    const b = blocks[i]
    if (b.type !== 'heading') return false
    if (isKnownSectionTitle(text(b.lines[0]))) return true
    if (b.level > sectionLevel) return false
    if (b.level !== 1) return true
    // An unknown h1 is the name, unless a name heading came before it.
    return blocks
      .slice(0, i)
      .some((x) => x.type === 'heading' && x.level === 1 && !isKnownSectionTitle(text(x.lines[0])))
  }

  // --- header: everything before the first section ---
  let firstSection = blocks.findIndex((_, i) => isOpener(i))
  if (firstSection < 0) firstSection = blocks.length
  const headerBlocks = blocks.slice(0, firstSection)

  const headerLines: Array<{ text: string; heading: boolean }> = []
  for (const b of headerBlocks) {
    if (b.type === 'heading' || b.type === 'paragraph') {
      for (const l of b.lines) headerLines.push({ text: text(l).trim(), heading: b.type === 'heading' })
    } else if (b.type === 'list') {
      for (const it of b.items) headerLines.push({ text: it.lines.map(text).join(' ').trim(), heading: false })
    }
  }
  const lines = headerLines.filter((l) => l.text)

  // The name chain. 1: a heading or early line that passes isLikelyName.
  let name = ''
  let nameAt = -1
  const firstTok = (s: string): string => s.split(TOKEN_SPLIT)[0].trim()
  const candidates = [
    ...lines.map((l, i) => ({ l, i })).filter((c) => c.l.heading),
    ...lines.map((l, i) => ({ l, i })).slice(0, 4).filter((c) => !c.l.heading),
  ]
  for (const c of candidates) {
    if (isLikelyName(firstTok(c.l.text))) {
      name = firstTok(c.l.text)
      nameAt = c.i
      break
    }
  }
  // 2: the first plain line that is not a section title, contact detail or long.
  if (!name) {
    const c = lines.findIndex((l) => {
      const t = firstTok(l.text)
      return (
        t.length > 0 && t.length <= 80 && !isKnownSectionTitle(t) && !EMAIL_RE.test(t) && !isPhone(t) && !URL_RE.test(t) && !t.includes('@')
      )
    })
    if (c >= 0) {
      name = firstTok(lines[c].text)
      nameAt = c
    }
  }
  // 3-5: the profile, the email, then a placeholder. Always with a warning.
  const basics: Resume['basics'] = { name: '', profiles: [] }
  const contactLines = lines.map((l) => l.text)
  const extras: string[] = []
  if (nameAt >= 0) {
    const rest = lines[nameAt].text.slice(firstTok(lines[nameAt].text).length)
    contactLines[nameAt] = rest.replace(TOKEN_SPLIT, '').trim() ? rest.trim() : ''
    if (contactLines[nameAt]) contactLines[nameAt] = contactLines[nameAt].replace(/^\s*(?:\||\u00b7|\u2022|\u2014|\u2013)\s*/, '')
  }
  for (let i = 0; i < contactLines.length; i++) {
    if (!contactLines[i]) continue
    for (const tok of contactLines[i].split(TOKEN_SPLIT).map((t) => t.trim()).filter(Boolean)) {
      if (EMAIL_RE.test(tok) && !basics.email) basics.email = tok.replace(/^mailto:/i, '')
      else if (isPhone(tok) && !basics.phone) basics.phone = tok
      else if (URL_RE.test(tok) && !tok.includes(' ')) {
        const host = Object.keys(NETWORKS).find((h) => tok.toLowerCase().includes(h))
        if (host) basics.profiles.push({ network: NETWORKS[host], url: tok })
        else if (!basics.url) basics.url = tok
        else basics.profiles.push({ network: tok.replace(/^https?:\/\//, '').split('/')[0], url: tok })
      } else if (LOCATION_HINT.test(tok) && !basics.location) basics.location = parseLocation(tok)
      else if (!basics.label) basics.label = tok
      else if (!basics.location) basics.location = parseLocation(tok)
      else extras.push(tok)
    }
  }
  if (extras.length) basics.label = [basics.label, ...extras].filter(Boolean).join(', ')

  if (!name) {
    name = fallbackName(ctx)
    warnings.push(NAME_WARNING)
  }
  basics.name = name

  // --- body ---
  const d: Draft = {
    work: [], education: [], skills: [], projects: [], certificates: [], awards: [], languages: [], custom: [], summary: [],
  }
  let kind = null as Kind | null
  let customItems = null as string[] | null
  let entry = null as Entry | null

  const startSection = (k: Kind, title: string) => {
    kind = k
    entry = null
    customItems = null
    if (k === 'custom') {
      customItems = []
      d.custom.push({ title, items: customItems })
    }
  }

  const startEntry = (title: string) => {
    const k = kind === 'education' || kind === 'projects' ? kind : 'work'
    const extracted = extractDates(title, k === 'education')
    const dates = extracted.dates
    // "Role, Company | Seattle, WA | Mar 2021 - Present": the part after the
    // first pipe is meta (location), not part of the title.
    const [rest, ...metaTokens] = extracted.rest.split(/\s+\|\s+/)
    if (k === 'education') {
      const isInst = (x: string) => /universit|college|institut|school|academy/i.test(x)
      const [a, b] = splitTitle(rest)
      let institution = ''
      let degreeText = ''
      if (b) [institution, degreeText] = isInst(a) && !isInst(b) ? [a, b] : [b, a]
      else if (isInst(a)) institution = a
      else degreeText = a
      const e: Resume['education'][number] = {
        institution,
        ...splitDegree(degreeText),
        ...(dates ? datesFor(dates, 'education') : { current: false }),
        courses: [],
      }
      d.education.push(e)
      entry = e
    } else if (k === 'projects') {
      const p: Resume['projects'][number] = {
        name: rest,
        ...(dates ? datesFor(dates, 'work') : { current: false }),
        highlights: [],
      }
      d.projects.push(p)
      entry = p
    } else {
      const [position, company] = splitTitle(rest)
      const w: Resume['work'][number] = {
        name: company,
        position,
        ...(dates ? datesFor(dates, 'work') : { current: false }),
        highlights: [],
      }
      d.work.push(w)
      entry = w
    }
    if (metaTokens.length) applyMeta(metaTokens.join(' | '))
  }

  const applyMeta = (line: string) => {
    if (!entry) return
    for (const tok of line.split(TOKEN_SPLIT).map((t) => t.trim()).filter(Boolean)) {
      const e = entry as Resume['work'][number] & Resume['education'][number] & Resume['projects'][number]
      const hasDates = Boolean(e.startDate || e.endDate || e.current || e.dateLabel)
      if (/^GPA\b/i.test(tok) && kind === 'education') e.score = tok.replace(/^GPA\s*/i, '')
      else if (dateish(tok) && !hasDates) Object.assign(e, datesFor(tok, kind === 'education' ? 'education' : 'work'))
      else if (kind === 'projects' && URL_RE.test(tok)) e.url = tok
      else if (kind === 'projects') e.description = [e.description, tok].filter(Boolean).join(' ')
      else e.location = [e.location, tok].filter(Boolean).join(', ')
    }
  }

  const addEntryText = (t: string) => {
    if (!entry) return
    if (kind === 'education') (entry as Resume['education'][number]).courses.push(t)
    else if (kind === 'projects') {
      const p = entry as Resume['projects'][number]
      p.description = [p.description, t].filter(Boolean).join('\n')
    } else {
      const w = entry as Resume['work'][number]
      w.summary = [w.summary, t].filter(Boolean).join('\n')
    }
  }

  const addHighlight = (t: string) => {
    if (!entry) return
    if (kind === 'education') (entry as Resume['education'][number]).courses.push(t)
    else (entry as Resume['work'][number]).highlights.push(t)
  }

  const simpleItem = (line: ResumeInlineLine) => {
    const t = text(line).trim()
    if (!t) return
    switch (kind) {
      case 'skills': {
        const g = parseSkillLine(line)
        if (g.keywords.length) d.skills.push(g)
        break
      }
      case 'certificates': {
        const parts = t.split(/\s+(?:\||\u2014|\u2013)\s+|,\s+/).map((p) => p.trim()).filter(Boolean)
        const dp = parts.findIndex((p, i) => i > 0 && dateish(p))
        const cert: Resume['certificates'][number] = { name: parts[0] ?? t }
        const date = dp >= 0 ? parts.splice(dp, 1)[0] : undefined
        if (date) {
          const r = datesFor(date, 'work')
          if (r.startDate) cert.date = r.startDate
          else cert.dateLabel = date
        }
        if (parts[1]) cert.issuer = parts.slice(1).join(', ')
        d.certificates.push(cert)
        break
      }
      case 'awards': {
        const parts = t.split(/\s+(?:\||\u2014|\u2013)\s+/).map((p) => p.trim()).filter(Boolean)
        const award: Resume['awards'][number] = { title: parts[0] ?? t }
        const rest = parts.slice(1)
        const dp = rest.findIndex(dateish)
        if (dp >= 0) {
          const r = datesFor(rest.splice(dp, 1)[0], 'work')
          if (r.startDate) award.date = r.startDate
          else award.dateLabel = r.dateLabel
        }
        if (rest[0]) award.awarder = rest[0]
        if (rest[1]) award.summary = rest.slice(1).join(' ')
        d.awards.push(award)
        break
      }
      case 'languages': {
        const m = /^(.*?)\s*\(([^)]+)\)$/.exec(t) ?? /^(.*?)\s*(?:\||:|\s-\s|\u2014|\u2013)\s*(.+)$/.exec(t)
        d.languages.push(m ? { language: m[1].trim(), fluency: m[2].trim() } : { language: t })
        break
      }
      case 'custom':
        customItems?.push(t)
        break
      case 'summary':
        d.summary.push(t)
        break
    }
  }

  const addListItem = (item: { lines: ResumeInlineLine[] }) => {
    const first = item.lines[0] ?? []
    const t = item.lines.map(text).join(' ').trim()
    if (!t) return
    if (kind === 'work' || kind === 'education') {
      if (!entry) startEntry('')
      addHighlight(t)
    } else if (kind === 'projects') {
      if (entry) addHighlight(t)
      else {
        // A flat project list: "**Name** - description".
        const lead = first[0]
        if (lead?.bold && first.length > 1) {
          const rest = first.slice(1).map((r) => r.text).join('').replace(/^\s*[:\u2014\u2013-]?\s*/, '')
          const p: Resume['projects'][number] = {
            name: lead.text.trim(),
            description: [rest, ...item.lines.slice(1).map(text)].join(' ').trim() || undefined,
            current: false,
            highlights: [],
          }
          d.projects.push(p)
        } else {
          d.projects.push({ name: t, current: false, highlights: [] })
        }
      }
    } else if (kind === 'skills') {
      simpleItem(item.lines.length > 1 ? [{ text: t }] : first)
    } else {
      simpleItem([{ text: t }])
    }
  }

  for (let bi = firstSection; bi < blocks.length; bi++) {
    const b = blocks[bi]
    const next = blocks[bi + 1]
    if (b.type === 'rule') continue
    if (b.type === 'heading') {
      const t = text(b.lines[0]).trim()
      if (isOpener(bi)) {
        const title = t.replace(/[:\uff1a]\s*$/, '')
        startSection(sectionKind(title), title)
      } else if (kind === 'work' || kind === 'education' || kind === 'projects') startEntry(t)
      else simpleItem([{ text: t }])
      continue
    }
    if (b.type === 'list') {
      for (const it of b.items) addListItem(it)
      continue
    }
    if (kind === 'summary') {
      // Soft-broken lines are one paragraph, not separate items.
      d.summary.push(b.lines.map(text).join('\n'))
      continue
    }
    // The title of an entry may be a plain line followed by a bold or italic
    // meta line ("Seattle, WA | Mar 2021 - Present"), so a line is judged with
    // the one after it.
    let startedHere = false
    const isMeta = (l?: ResumeInlineLine): boolean =>
      Boolean(l) && (allBold(l!) || allItalic(l!) || (dateish(text(l!)) && text(l!).length < 60 && !/[.!?]$/.test(text(l!).trim())))
    b.lines.forEach((l, li) => {
      const t = text(l).trim()
      if (!t) return
      if (kind !== 'work' && kind !== 'education' && kind !== 'projects') return simpleItem(l)
      const meta = isMeta(l)
      const nextLine = b.lines[li + 1]
      if (startedHere && meta && entry && !hasDates(entry)) return applyMeta(t)
      if (allBold(l)) {
        startedHere = true
        return startEntry(t)
      }
      if (allItalic(l)) {
        if (!entry) startEntry('')
        return applyMeta(t)
      }
      const lastLine = li === b.lines.length - 1
      const startsEntry =
        !entry ||
        (nextLine && isMeta(nextLine)) ||
        (lastLine && next?.type === 'list' && entryHasContent(entry))
      if (!startsEntry) {
        if (entry && !hasDates(entry) && meta) return applyMeta(t)
        return addEntryText(t)
      }
      startedHere = true
      if (kind === 'projects' && l[0]?.bold && l.length > 1) {
        const rest = l.slice(1).map((r) => r.text).join('').replace(/^\s*[:\u2014\u2013-]?\s*/, '')
        const p: Resume['projects'][number] = {
          name: l[0].text.trim(),
          description: rest || undefined,
          current: false,
          highlights: [],
        }
        d.projects.push(p)
        entry = p
      } else startEntry(t)
    })
  }

  const summary = d.summary.map((p) => p.trim()).filter(Boolean).join('\n\n')
  if (summary) basics.summary = summary

  const draft = {
    basics,
    work: d.work.filter((w) => w.name || w.position || w.highlights.length || w.summary),
    education: d.education.filter((e) => e.institution || e.area || e.studyType || e.courses.length),
    skills: d.skills,
    projects: d.projects.filter((p) => p.name || p.description || p.highlights.length),
    certificates: d.certificates,
    awards: d.awards,
    languages: d.languages,
    meta: {
      cello: {
        parsedFrom: ctx.parsedFrom,
        structuredBy: 'heuristic' as const,
        customSections: d.custom.filter((c) => c.items.length > 0),
        warnings,
      },
    },
  }
  return ResumeSchema.parse(draft)
}

function hasDates(e: Entry): boolean {
  const x = e as { startDate?: string; endDate?: string; current?: boolean; dateLabel?: string }
  return Boolean(x.startDate || x.endDate || x.current || x.dateLabel)
}

function entryHasContent(e: Entry): boolean {
  const x = e as { highlights?: string[]; courses?: string[]; summary?: string; description?: string }
  return Boolean(x.highlights?.length || x.courses?.length || x.summary || x.description)
}
