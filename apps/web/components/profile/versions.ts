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

/** Why a version cannot be deleted, or null when it can. */
export function deleteRefusal(v: VersionRow, currentBaseId: string | null): string | null {
  if (v.sent) return `This version was sent to ${v.sent.company ?? 'an employer'}. It stays with that application.`
  if (v.id === currentBaseId) return 'This is your base resume. Edit it to make a new version.'
  return null
}
