// Add an application by hand, or from a CSV. The person tells Cello about one they made themselves:
// a company, a title, a link, a stage and a date. It becomes a role (source manual) at a company the
// person does not follow (watching stays false: adding a record is not following), and an
// application with no state, since Cello is not working on it.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeCompanyName, resolveCompany } from '@/lib/entities/companies'
import { STAGES, type Stage } from './types'

export interface ByHand {
  company: string
  title: string
  url?: string | null
  stage?: string | null
  appliedAt?: string | null
}

export type Added = { ok: true; applicationId: string; existed: boolean } | { ok: false; sentence: string }

const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s)

export async function addByHand(admin: SupabaseClient, userId: string, input: ByHand, source: 'manual' | 'import' = 'manual'): Promise<Added> {
  const company = input.company.trim().slice(0, 200)
  const title = input.title.trim().slice(0, 300)
  if (!company || !title) return { ok: false, sentence: 'Add a company and a job title.' }
  const stage = (input.stage?.trim() || 'applied').toLowerCase()
  if (!isStage(stage)) return { ok: false, sentence: `${input.stage} is not a stage.` }
  let appliedAt: string | null = null
  if (input.appliedAt) {
    const t = new Date(input.appliedAt)
    if (Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 86_400_000) return { ok: false, sentence: 'That date is not one Cello can use.' }
    appliedAt = t.toISOString()
  }
  const url = input.url?.trim() || null
  if (url && !/^https?:\/\//i.test(url)) return { ok: false, sentence: 'The link must start with http or https.' }

  let companyId = (await resolveCompany(admin, userId, { name: company }))?.id
  if (!companyId) {
    const ins = await admin
      .from('companies')
      .insert({ user_id: userId, name: company, name_key: normalizeCompanyName(company) || null, career_url: '' })
      .select('id')
      .single()
    if (ins.error || !ins.data) return { ok: false, sentence: 'Could not save that. Try again.' }
    companyId = (ins.data as { id: string }).id
  }

  const externalId = `by-hand:${createHash('sha256').update(`${title.toLowerCase()}|${url ?? ''}`).digest('hex').slice(0, 24)}`
  // upsert, not a read: the same title and link at the same company is the same role
  const made0 = await admin
    .from('jobs')
    .upsert({ company_id: companyId, title, description: '', url: url ?? `https://cello.invalid/by-hand/${externalId}`, external_id: externalId }, { onConflict: 'company_id,external_id' })
    .select('id')
    .single()
  if (made0.error || !made0.data) return { ok: false, sentence: 'Could not save that. Try again.' }
  const job = made0.data
  const jobId = (job as { id: string }).id

  const have = await admin.from('applications').select('id').eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  if (have.data) return { ok: true, applicationId: (have.data as { id: string }).id, existed: true }
  const made = await admin
    .from('applications')
    .insert({ user_id: userId, job_id: jobId, stage, applied_at: stage === 'discovered' ? null : (appliedAt ?? new Date().toISOString()), source })
    .select('id')
    .single()
  if (made.error || !made.data) return { ok: false, sentence: 'Could not save that. Try again.' }
  return { ok: true, applicationId: (made.data as { id: string }).id, existed: false }
}

// --- CSV -------------------------------------------------------------------

/** Rows of a CSV with quoted fields, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim())) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

/** A cell that starts like a formula is quoted with a leading apostrophe, so a spreadsheet never runs it. */
export function csvCell(v: string | null | undefined): string {
  let s = v ?? ''
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const COLUMNS = ['company', 'title', 'url', 'stage', 'applied date'] as const

/** CSV columns company, title, url, stage, applied date (a header row names them). Reads at most 500 rows. */
export function readImport(text: string): { rows: ByHand[]; sentence?: string } {
  const all = parseCsv(text)
  if (all.length === 0) return { rows: [], sentence: 'That file is empty.' }
  const head = all[0].map((h) => h.trim().toLowerCase())
  const at = (name: string) => head.indexOf(name)
  if (at('company') < 0 || at('title') < 0) return { rows: [], sentence: `The first row needs these columns: ${COLUMNS.join(', ')}.` }
  const rows = all.slice(1, 501).map((r) => ({
    company: r[at('company')] ?? '',
    title: r[at('title')] ?? '',
    url: at('url') >= 0 ? r[at('url')] : null,
    stage: at('stage') >= 0 ? r[at('stage')] : null,
    appliedAt: at('applied date') >= 0 ? r[at('applied date')] : null,
  }))
  return { rows }
}
