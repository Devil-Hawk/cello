// How a saved resume version is named on Profile, and when it may be deleted. Pure.
// A label comes from the role and company a version was made for and the day it was sent,
// never from a file name (an upload's file name becomes the version title).

import type { ResumeDocument } from '@/lib/resume/types'

export interface VersionRow extends ResumeDocument {
  /** The role this version was made for, when it is in a role bucket. */
  role: { title: string; company: string | null } | null
  /** Set when an application sent this version. */
  sent: { at: string; company: string | null } | null
}

const FILE_NAME = /\.(pdf|docx?|txt|md|rtf|png|jpe?g|webp)$/i

/** A title worth showing: typed by the person or made by Cello, not a file name. */
export function usableTitle(title: string | null | undefined): string | null {
  const t = title?.trim()
  return t && !FILE_NAME.test(t) ? t : null
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Data Platform, for Senior Backend Engineer at Northwind Atlas, sent Oct 4". */
export function versionLabel(v: VersionRow): string {
  const parts: string[] = []
  const title = usableTitle(v.title)
  if (title) parts.push(title)
  if (v.role) parts.push(`for ${v.role.title}${v.role.company ? ` at ${v.role.company}` : ''}`)
  if (parts.length === 0) parts.push(v.job_id ? 'Tailored resume' : 'Base resume')
  if (v.sent) parts.push(`sent ${day(v.sent.at)}`)
  const label = parts.join(', ')
  return label[0].toUpperCase() + label.slice(1)
}

/**
 * What a version is compared with: a tailored one against the newest base, a base one against the
 * base version just before it. Null when there is nothing to compare with.
 */
export function compareWith(v: VersionRow, all: VersionRow[]): VersionRow | null {
  const newest = (rows: VersionRow[]) => rows.reduce<VersionRow | null>((a, b) => (!a || b.version > a.version ? b : a), null)
  const base = all.filter((r) => r.job_id === null && r.id !== v.id)
  return v.job_id ? newest(base) : newest(base.filter((r) => r.version < v.version))
}

export interface TailorTarget {
  jobId: string
  title: string
  company: string | null
  /** Newest version already made for this role, or null. */
  tailoredVersion: number | null
}

export interface AppRole {
  jobId: string
  title: string
  company: string | null
}

/**
 * The roles Tailor can start on: the person's applications, and every role that already has a
 * tailored version (so a version made earlier stays reachable). Already tailored first.
 */
export function tailorTargets(apps: AppRole[], versions: VersionRow[], limit = 20): TailorTarget[] {
  const tailored = new Map<string, number>()
  for (const v of versions) if (v.job_id && v.version > (tailored.get(v.job_id) ?? 0)) tailored.set(v.job_id, v.version)

  const out = new Map<string, TailorTarget>()
  const add = (jobId: string, title: string, company: string | null) => {
    if (!out.has(jobId)) out.set(jobId, { jobId, title, company, tailoredVersion: tailored.get(jobId) ?? null })
  }
  for (const a of apps) add(a.jobId, a.title, a.company)
  for (const v of versions) if (v.job_id && v.role) add(v.job_id, v.role.title, v.role.company)
  return [...out.values()].sort((a, b) => Number(b.tailoredVersion !== null) - Number(a.tailoredVersion !== null)).slice(0, limit)
}

/** Why a version cannot be deleted, or null when it can. */
export function deleteRefusal(v: VersionRow, currentBaseId: string | null): string | null {
  if (v.sent) return `This version was sent to ${v.sent.company ?? 'an employer'}. It stays with that application.`
  if (v.id === currentBaseId) return 'This is your base resume. Edit it to make a new version.'
  return null
}
