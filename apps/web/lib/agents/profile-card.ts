// A short card about the person, put at the end of the orchestrator's system prompt.
//
// Everything on it comes from the person's own record: what they said they want, what they
// rule out, what they told Cello to remember, and how many applications they have. It is
// compact on purpose (ids and counts, never documents), so the prompt stays stable and
// cacheable; the resume itself is read with my_profile when it is needed.

import { readStandingPreferences } from '@/lib/insights/store'
import { resolveTargeting } from '@/lib/targeting'
import type { AdminClient } from '@/lib/harness/types'

const line = (label: string, values: readonly string[] | string | null | undefined): string | null => {
  const list = Array.isArray(values) ? values.filter(Boolean) : values ? [String(values)] : []
  return list.length ? `${label}: ${list.join(', ')}` : null
}

export async function profileCard(admin: AdminClient, userId: string, now: Date = new Date()): Promise<string> {
  const { data } = await admin.from('profiles').select('full_name, resume_text, preferences').eq('id', userId).single()
  const profile = (data ?? {}) as { full_name?: string | null; resume_text?: string | null; preferences?: Record<string, unknown> | null }
  const prefs = profile.preferences ?? {}
  const targeting = resolveTargeting(prefs)
  const resume = (profile.resume_text ?? '').trim()
  const headline = resume.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 160)

  const { data: apps } = await admin.from('applications').select('stage').eq('user_id', userId).limit(500)
  const byStage: Record<string, number> = {}
  for (const a of (apps as { stage: string }[] | null) ?? []) byStage[a.stage] = (byStage[a.stage] ?? 0) + 1

  const locations = Array.isArray(prefs.preferredLocations) ? (prefs.preferredLocations as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const standing = (await readStandingPreferences(admin, userId).catch(() => '')).trim()

  const lines = [
    'ABOUT THE PERSON (from their own record):',
    line('Name', profile.full_name),
    resume ? `Resume on file: ${resume.split(/\s+/).length} words. Starts: ${headline}` : 'Resume on file: none. Ask them to upload one in Settings before writing anything about them.',
    line('Looking for', [...targeting.functions, ...targeting.seniority]),
    line('Places', [...locations, ...targeting.countries, targeting.remoteOnly ? 'remote only' : '']),
    line('Rules out (companies)', targeting.excludedCompanies),
    line('Rules out (words)', targeting.excludedKeywords),
    Object.keys(byStage).length ? `Applications: ${Object.entries(byStage).map(([s, n]) => `${n} ${s}`).join(', ')}` : 'Applications: none yet.',
    `Today: ${now.toISOString().slice(0, 10)}`,
  ].filter((l): l is string => Boolean(l))
  return standing ? `${lines.join('\n')}\n\n${standing}` : lines.join('\n')
}
