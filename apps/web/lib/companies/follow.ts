// Follow an employer for a person: the one place the directory's add path writes a person's companies row.
//
// A person's `companies` row is their own (notes, dream flag, who they know there); the employer it points at is
// shared (company_directory). Following gives the person a row tied to the employer and to its verified board, so
// their next check reads that board and keeps the roles inside their targets. K13 later makes this the only writer.

import type { SupabaseClient } from '@supabase/supabase-js'
import { saveCompany } from './add'
import type { DirectoryRow } from './directory'

type Db = SupabaseClient<any, any, any>

export type Followed = { id: string; error?: undefined } | { id?: undefined; error: string }

export async function followEmployer(db: Db, userId: string, employer: Pick<DirectoryRow, 'id' | 'name' | 'domain' | 'logo_url' | 'careers_url' | 'ats_provider' | 'ats_token' | 'verified_by'>, source: 'url' | 'known'): Promise<Followed> {
  const saved = await saveCompany(db, userId, { name: employer.name, domain: employer.domain, careerUrl: employer.careers_url, logoUrl: employer.logo_url, isDream: false })
  if (saved.error !== undefined) return { error: saved.error }

  // The board the verifier tied to the employer is the pointer a refresh reads first; no guessing by name.
  const { data } = await db.from('companies').select('metadata').eq('id', saved.id).eq('user_id', userId).maybeSingle()
  const metadata: Record<string, unknown> = { ...((data as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) }
  if (employer.ats_provider && employer.ats_token) {
    metadata.ats = { provider: employer.ats_provider, token: employer.ats_token, source, discovered_at: new Date().toISOString(), verified_by: employer.verified_by ?? undefined, verified_at: new Date().toISOString() }
  }
  const { error } = await db.from('companies').update({ employer_id: employer.id, watching: true, metadata }).eq('id', saved.id).eq('user_id', userId)
  if (error) return { error: `Could not follow ${employer.name}: ${error.message}` }
  return { id: saved.id }
}
