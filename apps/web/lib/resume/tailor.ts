// Tailoring as a patch, merged in code. The model returns only the fields it
// changes (summary, skills, highlights per entry index); everything else comes
// from the base resume, so identity fields (employers, titles, dates,
// education, the template) cannot change: the patch has no slot for them.
//
// Every change is measured against the BASE resume's text, and a failing one
// reverts to the base value with a warning. Nothing the base did not say gets
// through, and the user sees what was dropped.

import { findInventedFacts } from './import/llm'
import { resumeToPlainText } from './render'
import { ResumeSchema, type Resume, type TailorPatch } from './schema'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A whole-token, case-insensitive match: "Go" is not found inside "Google", "C++" is found in "C++". */
function hasToken(haystack: string, token: string): boolean {
  const t = token.trim()
  if (!t) return false
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'i').test(haystack)
}

/**
 * Hard facts in `text` that the base never said. A bullet's first word is
 * capitalised only because it starts a sentence, so it is lowercased first.
 * ponytail: an invented proper noun in the very first word of a bullet slips
 * through; add a verb list if a model ever does that.
 */
function invented(basePlain: string, text: string): string[] {
  const lowered = text.replace(/(^|\n)([A-Z])([a-z])/g, (_m, a: string, b: string, c: string) => a + b.toLowerCase() + c)
  return findInventedFacts(basePlain, lowered)
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
const similar = (a: string, b: string): boolean => {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return false
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / Math.min(x.size, y.size) >= 0.5
}

/**
 * A tailored entry may reorder, reword and tighten its own bullets, never swap them for others: every new bullet must say
 * what one of the entry's own bullets said, and at least half of what the entry had must still be said. A model that moves
 * a project's lines under a job (and drops the job's real ones) fails this, and the entry keeps what the base had.
 */
export function keepsEntry(before: string[], after: string[]): boolean {
  const kept = before.filter((b) => after.some((a) => similar(a, b))).length
  return after.every((a) => before.some((b) => similar(a, b))) && kept >= Math.ceil(before.length / 2)
}

export function applyTailorPatch(base: Resume, patch: TailorPatch): { resume: Resume; warnings: string[]; changes: string[] } {
  const basePlain = resumeToPlainText(base)
  const out: Resume = structuredClone(base)
  const dropped: string[] = []
  const changes: string[] = []
  const swapped: string[] = []

  // --- summary ---
  const summary = patch.summary.trim()
  if (summary) {
    const bad = invented(basePlain, summary)
    if (bad.length) dropped.push(...bad)
    else if (summary !== (base.basics.summary ?? '').trim()) {
      out.basics.summary = summary
      changes.push('Summary reworded to speak to this posting, using only what your resume says.')
    }
  }

  // --- highlights per entry; unknown indexes are ignored ---
  const apply = (
    target: Array<{ highlights: string[]; name?: string; position?: string }>,
    patches: TailorPatch['work']
  ): void => {
    for (const p of patches) {
      const entry = target[p.index]
      if (!entry) continue
      const highlights = p.highlights.map((h) => h.trim()).filter(Boolean)
      if (highlights.length === 0) continue
      const bad = invented(basePlain, highlights.join('\n'))
      const label = [entry.position, entry.name].filter(Boolean).join(', ') || `entry ${p.index + 1}`
      if (bad.length) dropped.push(...bad)
      else if (!keepsEntry(entry.highlights, highlights)) swapped.push(label)
      else if (highlights.join('\n') !== entry.highlights.join('\n')) {
        const moved = highlights.some((h, i) => !similar(h, entry.highlights[i] ?? ''))
        changes.push(`${label}: ${moved ? 'bullets reordered, the most relevant first, and reworded to match the posting' : 'bullets reworded to match the posting'}. Nothing was added that your resume does not say.`)
        entry.highlights = highlights
      }
    }
  }
  apply(out.work, patch.work)
  apply(out.projects, patch.projects)

  // --- skills: per keyword, then per group name ---
  const baseSkillWords = new Set(base.skills.flatMap((s) => s.keywords.map((k) => k.trim().toLowerCase())))
  const baseGroupNames = new Set(base.skills.map((s) => s.name.trim().toLowerCase()))
  const keywordOk = (k: string): boolean => baseSkillWords.has(k.trim().toLowerCase()) || hasToken(basePlain, k)

  // The patch merges into the base groups, it never replaces them: a group or a
  // keyword the model leaves out stays, so no real skill disappears from the
  // resume. The patch's keywords come first, which is how it reorders.
  const merged: Resume['skills'] = out.skills.map((g) => ({ ...g, keywords: [...g.keywords] }))
  patch.skills.forEach((g, i) => {
    const keywords = [
      ...new Map(
        g.keywords
          .map((k) => k.trim())
          .filter(Boolean)
          .filter((k) => {
            if (keywordOk(k)) return true
            dropped.push(k)
            return false
          })
          .map((k) => [k.toLowerCase(), k] as const)
      ).values(),
    ]
    if (keywords.length === 0) return
    let name = g.name.trim()
    if (name && !baseGroupNames.has(name.toLowerCase()) && !hasToken(basePlain, name)) {
      dropped.push(name)
      name = ''
    }
    // An unnamed or invented group lands on the base group at its position.
    const at = name
      ? merged.findIndex((m) => m.name.trim().toLowerCase() === name.toLowerCase())
      : i < merged.length
        ? i
        : -1
    if (at < 0) {
      merged.push({ name: name || 'Skills', keywords })
      return
    }
    const mine = new Set(keywords.map((k) => k.toLowerCase()))
    const before = merged[at].keywords.join('|')
    merged[at].keywords = [...keywords, ...merged[at].keywords.filter((k) => !mine.has(k.toLowerCase()))]
    if (merged[at].keywords.join('|') !== before) changes.push(`Skills, ${merged[at].name}: ${keywords.slice(0, 4).join(', ')} moved to the front because the posting asks for them.`)
  })
  out.skills = merged

  const warnings: string[] = []
  if (swapped.length) warnings.push(`Changes to ${swapped.join('; ')} were dropped because they did not keep what that entry says.`)
  if (dropped.length) {
    const unique = [...new Set(dropped)]
    warnings.push(
      `${unique.length} suggestion${unique.length === 1 ? ' was' : 's were'} dropped because ${
        unique.length === 1 ? 'it is' : 'they are'
      } not in your resume: ${unique.slice(0, 8).join(', ')}${unique.length > 8 ? ', and more' : ''}`
    )
  }
  out.meta.cello.structuredBy = 'tailor'
  out.meta.cello.warnings = warnings
  return { resume: ResumeSchema.parse(out), warnings, changes }
}

const STOP = new Set('with that this from your will have they their about into more also been were work team role what such than them these those which while where when over only other must including across strong experience ability years year new used using able best make well need needs help join company people working build building'.split(' '))

/**
 * The posting's own words that carry weight: the title's, and any other word it uses more than once. Code, so the order a
 * person sees is the same every time and never depends on a model's mood.
 */
function jobWords(job: { title: string; description?: string | null }): string[] {
  const count = new Map<string, number>()
  for (const raw of (job.description ?? '').toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? []) {
    const w = raw.replace(/[.-]+$/, '')
    if (w.length >= 4 && !STOP.has(w)) count.set(w, (count.get(w) ?? 0) + 1)
  }
  const fromTitle = (job.title.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w))
  return [...new Set([...fromTitle, ...[...count].filter(([, n]) => n >= 2).map(([w]) => w)])]
}

/**
 * Within each job, the bullets that share the most words with the posting come first. Nothing is added, removed or
 * reworded; an entry whose first bullet is already the best match is left alone. Each move is named, with why.
 */
export function rankBulletsForJob(resume: Resume, job: { title: string; description?: string | null }): { resume: Resume; changes: string[] } {
  const out: Resume = structuredClone(resume)
  const changes: string[] = []
  const words = jobWords(job)
  if (words.length === 0) return { resume: out, changes }
  const shared = (b: string) => words.filter((w) => hasToken(b, w))
  for (const entry of out.work) {
    if (entry.highlights.length < 2) continue
    const scored = entry.highlights.map((h, i) => ({ h, i, hits: shared(h) }))
    const ranked = [...scored].sort((a, b) => b.hits.length - a.hits.length || a.i - b.i)
    // One shared word is chance; two is a reason.
    if (ranked[0].i === 0 || ranked[0].hits.length < 2 || ranked[0].hits.length <= scored[0].hits.length) continue
    entry.highlights = ranked.map((r) => r.h)
    const top = ranked[0]
    changes.push(`${[entry.position, entry.name].filter(Boolean).join(', ')}: "${top.h.slice(0, 70).replace(/\s+\S*$/, '')}..." moved to the top, because it shares ${top.hits.slice(0, 3).join(', ')} with the posting. Nothing was added or removed.`)
  }
  return { resume: ResumeSchema.parse(out), changes }
}
