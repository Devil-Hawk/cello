// Agent: enricher — add INSIDER-CONNECTION signal to jobs/companies.
//
// OWNER: contacts + cold-outreach workstream (P5). Insider connections come
// strictly from the user's OWN contacts graph (populated from their OWN Gmail by
// POST /api/gmail/enrich, and/or opt-in Hunter enrichment) — NO LinkedIn / third-
// party scraping. Output MUST satisfy EnricherOutput.
//
// NOTE ON GMAIL: mining recruiter/hiring-manager correspondence needs the user's
// Google provider_token, which only exists in a request session — NOT in the
// harness/cron context this agent runs in. So Gmail header mining lives in
// app/api/gmail/enrich (request context); here we (a) surface insider matches
// from the already-populated contacts table and (b) run opt-in Hunter enrichment
// (a plain HTTPS API that works without a Gmail token).

import type { AgentFn } from '../types'
import { EnricherInput } from '../schemas'
import { readOutreachConfig } from '@/lib/outreach/config'
import { findContacts } from '@/lib/outreach/hunter'

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'mail.com', 'live.com', 'msn.com',
])

interface CompanyRow {
  id: string
  name: string
  domain: string | null
}
interface ContactRow {
  id: string
  name: string
  email: string | null
  title: string | null
  relationship: string | null
  company_id: string | null
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
}
function domainOf(email: string | null | undefined): string | null {
  if (!email) return null
  const m = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/)
  return m ? m[1] : null
}

export const enricher: AgentFn = async (ctx) => {
  const input = EnricherInput.parse(ctx.input ?? {})

  // 1) Resolve the set of target companies (from companyIds and/or jobIds).
  const companyIds = new Set<string>(input.companyIds ?? [])
  const jobToCompany = new Map<string, string>()
  if (input.jobIds && input.jobIds.length > 0) {
    const { data: jobs } = await ctx.admin
      .from('jobs')
      .select('id, company_id')
      .in('id', input.jobIds)
    for (const j of (jobs as { id: string; company_id: string }[]) ?? []) {
      if (j.company_id) {
        companyIds.add(j.company_id)
        jobToCompany.set(j.id, j.company_id)
      }
    }
  }

  if (companyIds.size === 0) {
    return { output: { enriched: [] }, tokensUsed: 0 }
  }

  const { data: companyData } = await ctx.admin
    .from('companies')
    .select('id, name, domain')
    .eq('user_id', ctx.userId)
    .in('id', Array.from(companyIds))
  const companies = (companyData as CompanyRow[]) ?? []
  const companyById = new Map(companies.map((c) => [c.id, c]))

  // 2) Load the user's OWN contacts once.
  const { data: contactData } = await ctx.admin
    .from('contacts')
    .select('id, name, email, title, relationship, company_id')
    .eq('user_id', ctx.userId)
  const contacts = (contactData as ContactRow[]) ?? []
  const existingEmails = new Set(
    contacts.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e)
  )

  // 3) Opt-in Hunter enrichment (works without a Gmail token).
  const config = await readOutreachConfig(ctx.admin, ctx.userId)
  const enrichedAddedByCompany = new Map<string, number>()
  if (config.hunterKey) {
    for (const company of companies) {
      const domain = company.domain?.toLowerCase().replace(/^www\./, '') || null
      if (!domain || PERSONAL_DOMAINS.has(domain)) continue
      if (ctx.signal.aborted) break
      const found = await findContacts(domain, config.hunterKey, { limit: 10, signal: ctx.signal })
      let added = 0
      for (const person of found) {
        if (existingEmails.has(person.email)) continue
        const { data: inserted } = await ctx.admin
          .from('contacts')
          .insert({
            user_id: ctx.userId,
            company_id: company.id,
            name: person.name || person.email.split('@')[0],
            email: person.email,
            title: person.title,
            relationship: 'enriched',
            notes: 'Sourced via Hunter enrichment (user-enabled).',
          })
          .select('id, name, email, title, relationship, company_id')
          .single()
        if (inserted) {
          existingEmails.add(person.email)
          contacts.push(inserted as ContactRow)
          added++
        }
      }
      if (added) enrichedAddedByCompany.set(company.id, added)
    }
  }

  // 4) Match contacts -> companies for the insider-connection signal.
  function insidersFor(company: CompanyRow) {
    const companyDomain = company.domain?.toLowerCase().replace(/^www\./, '') || null
    const nameNorm = normalizeName(company.name)
    const matches = contacts.filter((c) => {
      if (c.company_id && c.company_id === company.id) return true
      const cDomain = domainOf(c.email)
      if (companyDomain && cDomain && !PERSONAL_DOMAINS.has(cDomain) && cDomain === companyDomain) {
        return true
      }
      return false
    })
    // Rank: hiring managers first, then recruiters, then everyone else.
    const rank = (r: string | null) =>
      r === 'hiring_manager' ? 0 : r === 'recruiter' ? 1 : 2
    matches.sort((a, b) => rank(a.relationship) - rank(b.relationship))
    return { matches, nameNorm }
  }

  // 5) Build EnricherOutput — one entry per requested job (with its company's
  //    insiders) plus one per requested-only company.
  const enriched: {
    jobId?: string
    companyId?: string
    signals: Record<string, unknown>
  }[] = []

  const signalForCompany = (company: CompanyRow) => {
    const { matches } = insidersFor(company)
    return {
      companyId: company.id,
      companyName: company.name,
      insiderCount: matches.length,
      hasInsider: matches.length > 0,
      insiderConnections: matches.slice(0, 8).map((c) => ({
        contactId: c.id,
        name: c.name,
        title: c.title,
        relationship: c.relationship ?? 'contact',
        hasEmail: !!c.email,
      })),
      enrichedAdded: enrichedAddedByCompany.get(company.id) ?? 0,
    }
  }

  for (const jobId of input.jobIds ?? []) {
    const cid = jobToCompany.get(jobId)
    const company = cid ? companyById.get(cid) : undefined
    if (!company) {
      enriched.push({ jobId, signals: { insiderCount: 0, hasInsider: false, insiderConnections: [] } })
      continue
    }
    enriched.push({ jobId, companyId: company.id, signals: signalForCompany(company) })
  }

  const jobCompanyIds = new Set(jobToCompany.values())
  for (const cid of input.companyIds ?? []) {
    if (jobCompanyIds.has(cid)) continue
    const company = companyById.get(cid)
    if (!company) continue
    enriched.push({ companyId: cid, signals: signalForCompany(company) })
  }

  return { output: { enriched }, tokensUsed: 0 }
}
