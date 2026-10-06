// Company facts a draft may cite: the statements from the company research that
// carry a source, numbered D1.. with the page each came from. Research from
// before statements were cited has none, and a draft then says nothing about
// the company beyond the job post.

import type { AdminClient } from '../harness/types'
import { getDossierByCompany, type DossierSignals } from './store'

export interface CompanyFact {
  id: string
  text: string
  url: string
}

const MAX_FACTS = 8

/** Pure: the cited statements of one dossier as numbered facts with links. */
export function factsFromSignals(signals: DossierSignals | null | undefined): CompanyFact[] {
  if (!signals?.citations?.length || !signals.sourceList?.length) return []
  const urls = new Map(signals.sourceList.map((s) => [s.id, s.url]))
  const facts: CompanyFact[] = []
  for (const c of signals.citations) {
    if (c.field === 'uncertainty') continue
    const url = c.sources.map((id) => urls.get(id)).find((u): u is string => !!u)
    if (!url || !c.text.trim()) continue
    facts.push({ id: `D${facts.length + 1}`, text: c.field === 'techStack' ? `Tech stack: ${c.text}` : c.text.trim(), url })
    if (facts.length >= MAX_FACTS) break
  }
  return facts
}

export async function companyFacts(admin: AdminClient, userId: string, companyId: string | null): Promise<CompanyFact[]> {
  if (!companyId) return []
  try {
    const dossier = await getDossierByCompany(admin, userId, companyId)
    return factsFromSignals(dossier?.signals)
  } catch {
    return []
  }
}
