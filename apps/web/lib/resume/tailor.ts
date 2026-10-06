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

export function applyTailorPatch(base: Resume, patch: TailorPatch): { resume: Resume; warnings: string[] } {
  const basePlain = resumeToPlainText(base)
  const out: Resume = structuredClone(base)
  const dropped: string[] = []

  // --- summary ---
  const summary = patch.summary.trim()
  if (summary) {
    const bad = invented(basePlain, summary)
    if (bad.length) dropped.push(...bad)
    else out.basics.summary = summary
  }

  // --- highlights per entry; unknown indexes are ignored ---
  const apply = (
    target: Array<{ highlights: string[] }>,
    patches: TailorPatch['work']
  ): void => {
    for (const p of patches) {
      const entry = target[p.index]
      if (!entry) continue
      const highlights = p.highlights.map((h) => h.trim()).filter(Boolean)
      if (highlights.length === 0) continue
      const bad = invented(basePlain, highlights.join('\n'))
      if (bad.length) dropped.push(...bad)
      else entry.highlights = highlights
    }
  }
  apply(out.work, patch.work)
  apply(out.projects, patch.projects)

  // --- skills: per keyword, then per group name ---
  const baseSkillWords = new Set(base.skills.flatMap((s) => s.keywords.map((k) => k.trim().toLowerCase())))
  const baseGroupNames = new Set(base.skills.map((s) => s.name.trim().toLowerCase()))
  const keywordOk = (k: string): boolean => baseSkillWords.has(k.trim().toLowerCase()) || hasToken(basePlain, k)

  const groups: Resume['skills'] = []
  patch.skills.forEach((g, i) => {
    const keywords = g.keywords.map((k) => k.trim()).filter(Boolean).filter((k) => {
      if (keywordOk(k)) return true
      dropped.push(k)
      return false
    })
    if (keywords.length === 0) return
    let name = g.name.trim()
    if (name && !baseGroupNames.has(name.toLowerCase()) && !hasToken(basePlain, name)) {
      dropped.push(name)
      name = ''
    }
    groups.push({ name: name || base.skills[i]?.name || 'Skills', keywords })
  })
  if (groups.length > 0) out.skills = groups

  const warnings: string[] = []
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
  return { resume: ResumeSchema.parse(out), warnings }
}
