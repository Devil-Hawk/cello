'use server'

// What the Companies page does as the signed-in person. Each action names the person from the session; the browser
// never sends who it is. A refusal is a sentence, never a code.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isDemoProfile } from '@/lib/access/guardrails'
import { jobRow } from '@/lib/ats'
import type { AtsJob } from '@/lib/ats/types'
import { saveCompany } from '@/lib/companies/add'
import { employerDomain, parseLink } from '@/lib/companies/add-link'
import { getEmployer } from '@/lib/companies/directory'
import { nameFromDomain } from '@/lib/companies/page-name'
import { previewPosting } from '@/lib/companies/preview'
import { rpcSlotStore } from '@/lib/commands/slots'
import { FREE_CHECKS_PER_DAY, evidenceLive, startOfUtcDay, stripOf } from '@/lib/fit'
import { codeVerdicts } from '@/lib/fit/code'
import { runEvidenceStep } from '@/lib/fit/evidence'
import { loadMaterial } from '@/lib/fit/material'
import { modelReadsSince } from '@/lib/fit/store'
import type { RoleFitView } from '@/lib/fit/types'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { classifyJob } from '@/lib/jobs/classify'
import { createClient } from '@/lib/supabase/server'
import { checkedAgainLine, type Found } from '@/components/companies/logic'
import { RATE_LINE, REMOVE_REFUSED, closedLine } from '@/components/companies/company-logic'
import { followCompanies, type FollowResult } from './follow.stub'
import { findPosting, ownFor, previewRequirements } from './[id]/read'
import { findCompanies } from './read'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGN_IN = 'Sign in again to do that.'

async function person() {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  return { db, user }
}

/** Add or find's type-ahead. */
export async function findCompaniesAction(query: string): Promise<Found | { error: string }> {
  const { db, user } = await person()
  if (!user) return { error: SIGN_IN }
  try {
    return await findCompanies(db, user.id, query.trim().slice(0, 120))
  } catch {
    return { error: 'Could not search companies. Try again.' }
  }
}

/** Stop following, or pin and unpin, one of the person's own companies. */
export async function setFollow(companyId: string, change: { follow?: boolean; pin?: boolean }): Promise<FollowResult> {
  const { db, user } = await person()
  if (!user) return { ok: false, sentence: SIGN_IN }
  if (!UUID.test(companyId)) return { ok: false, sentence: 'Cello does not have that company.' }
  return followCompanies(db, user.id, [companyId], { follow: change.follow, pin: change.pin })
}

/** Follow an employer by the address the person gave, when its site could not be read: the guessed name, the domain and the careers link, shown as "cannot read". */
export async function followAnyway(link: string): Promise<{ ok: true; companyId: string; name: string } | { ok: false; sentence: string }> {
  const { db, user } = await person()
  if (!user) return { ok: false, sentence: SIGN_IN }
  const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', user.id).maybeSingle()
  if (isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null)) return { ok: false, sentence: 'The demo cannot add companies. Sign in with your own account to add one.' }
  const url = parseLink(link)
  if (!url) return { ok: false, sentence: 'Cello cannot read that address. Paste their careers page.' }
  const domain = employerDomain(url.hostname)
  const name = nameFromDomain(domain)
  const saved = await saveCompany(db, user.id, { name, domain, careerUrl: url.href, logoUrl: null, isDream: false })
  if (saved.error !== undefined) return { ok: false, sentence: saved.error.startsWith('You already track') ? saved.error : 'Could not save that. Try again.' }
  const followed = await followCompanies(db, user.id, [saved.id], { follow: true })
  return followed.ok ? { ok: true, companyId: saved.id, name } : { ok: false, sentence: followed.sentence }
}

/** Check now (one company) and Check all now: one an hour each, so a button cannot be a loop. */
export async function takeCheck(scope: 'all' | string): Promise<{ ok: true } | { ok: false; sentence: string }> {
  const { user } = await person()
  if (!user) return { ok: false, sentence: SIGN_IN }
  if (scope !== 'all' && !UUID.test(scope)) return { ok: false, sentence: 'Cello does not have that company.' }
  const now = Date.now()
  try {
    const ok = await rpcSlotStore(createAdminClient()).take({ userId: user.id, channel: 'page', bucket: scope === 'all' ? 'companies.check_all' : `companies.check:${scope}`, limit: 1, windowSeconds: 3600 })
    if (ok) return { ok: true }
  } catch {
    return { ok: false, sentence: 'Could not start that check. Try again.' }
  }
  return { ok: false, sentence: checkedAgainLine(new Date((Math.floor(now / 3_600_000) + 1) * 3_600_000).toISOString()) }
}

/** What keeping or checking a previewed posting needs: the employer, the person's own row for it, and the posting found in the live read by the employer's own key. Never a link from the browser. It takes a place in the same preview limit the page read does ('limited' when none is left), so a loop of calls cannot read boards. */
async function previewOf(db: Awaited<ReturnType<typeof createClient>>, userId: string, employerId: string, key: string) {
  if (!UUID.test(employerId) || key.length === 0 || key.length > 500) return null
  const admin = createAdminClient()
  const employer = await getEmployer(admin, employerId)
  if (!employer) return null
  if (!(await rpcSlotStore(admin).take({ userId, channel: 'page', bucket: 'roles.preview', limit: 30, windowSeconds: 600 }))) return 'limited' as const
  const own = await ownFor(db, userId, employerId)
  const found = await findPosting(db, userId, employer, own, key)
  if (!found) return null
  const preview = await previewPosting({ url: found.row.url, title: found.row.title })
  return preview ? { admin, employer, row: found.row, preview } : null
}

/** Interested, Apply, Save or Change type on a role that is not stored yet: it is stored now, once, for this person, marked as found from the company (keep_company_role). Save also saves it. */
export async function keepPreview(employerId: string, key: string, intent: 'keep' | 'save'): Promise<{ ok: true; id: string } | { ok: false; sentence: string }> {
  const { db, user } = await person()
  if (!user) return { ok: false, sentence: SIGN_IN }
  try {
    const got = await previewOf(db, user.id, employerId, key)
    if (got === 'limited') return { ok: false, sentence: RATE_LINE }
    if (!got) return { ok: false, sentence: closedLine }
    const { admin, employer, row, preview } = got
    const nowIso = new Date().toISOString()
    const job: AtsJob = {
      title: row.title,
      url: row.url,
      externalId: key,
      ...(row.location ? { location: row.location } : {}),
      ...(row.postedAt ? { postedAt: row.postedAt } : {}),
      ...(preview.salary_range ? { salary: preview.salary_range } : {}),
      ...(preview.description_md ? { description: preview.description_md } : {}),
    }
    const c = classifyJob({ title: row.title, description: preview.description_md ?? undefined, location: row.location ?? undefined, companyName: employer.name })
    const { company_id: _unused, ...base } = jobRow({ id: employer.id, employer_id: employer.id }, job, row.title, c, employer.ats_provider ?? 'listing', nowIso)
    // The whole posting as it was read, not the listing snippet jobRow would make of its description.
    const stored = { ...base, description_md: preview.description_md, description_state: preview.description_state, description_source: preview.description_source, apply_url: preview.apply_url, description_md5: preview.description_md5, requirements: preview.requirements }
    const { data, error } = await admin.rpc('keep_company_role', { p_user: user.id, p_employer: employer.id, p_row: stored })
    if (error || typeof data !== 'string') return { ok: false, sentence: 'Could not save that. Try again.' }
    if (intent === 'save') {
      // The generated types predate person_roles.saved_at.
      const { error: saveError } = await (db as unknown as SupabaseClient).from('person_roles').update({ saved_at: nowIso }).eq('user_id', user.id).eq('job_id', data)
      if (saveError) return { ok: false, sentence: 'Could not save that. Try again.' }
    }
    return { ok: true, id: data }
  } catch {
    return { ok: false, sentence: 'Could not save that. Try again.' }
  }
}

const CAP_LINE = `You have used today's ${FREE_CHECKS_PER_DAY} checks. Try again tomorrow.`

/** Check my chance on a previewed posting: code verdicts, then the declared step for what code could not settle. It counts against the daily cap and stores nothing; the verdicts are kept only when the person acts. */
export async function previewChance(employerId: string, key: string): Promise<{ ok: true; view: RoleFitView; kinds: Record<string, 'must' | 'nice' | 'other'> } | { ok: false; sentence: string }> {
  const { db, user } = await person()
  if (!user) return { ok: false, sentence: SIGN_IN }
  try {
    const got = await previewOf(db, user.id, employerId, key)
    if (got === 'limited') return { ok: false, sentence: RATE_LINE }
    if (!got) return { ok: false, sentence: closedLine }
    const { admin, preview } = got
    const { reqs, authorizationIds, kinds } = previewRequirements(preview)
    const material = await loadMaterial(admin, user.id)
    const code = codeVerdicts(reqs, material.sources, authorizationIds)
    const todo = reqs.filter((r, n) => code[n].verdict === 'unknown' && !authorizationIds.has(r.id))
    const view = (items: typeof code, readAt: string | null, needsModel: boolean): RoleFitView => ({ items, strip: stripOf(items), needsModel, readAt })
    const keys = await loadApiKeys(admin, user.id)
    if (todo.length === 0 || !(await evidenceLive(admin)) || !canRunLlm(keys)) return { ok: true, view: view(code, null, todo.length > 0), kinds }

    // One daily cap for every read of this kind: the role checks already made count, and a preview takes a place beside them.
    const used = await modelReadsSince(admin, user.id, startOfUtcDay(new Date()))
    // ponytail: preview reads are counted in command_slots beside role_evidence; one counter when the cap moves into the step.
    const left = FREE_CHECKS_PER_DAY - used
    if (left <= 0 || !(await rpcSlotStore(admin).take({ userId: user.id, channel: 'page', bucket: 'roles.check_chance', limit: left, windowSeconds: 86_400 }))) return { ok: false, sentence: CAP_LINE }
    const run = await runEvidenceStep({ userId: user.id, requirements: todo, sources: material.sources, keys })
    const items = code.map((c, n) => run?.items.find((i) => i.requirementId === reqs[n].id) ?? c)
    return { ok: true, view: view(items, run ? new Date().toISOString() : null, run === null), kinds }
  } catch {
    return { ok: false, sentence: 'Could not check your chance. Try again.' }
  }
}

/** Remove company: the person's own row only, never the employer from Companies. What stays (applications, conversations, people) is not touched; a refusal from the database is said in a sentence. */
export async function removeCompany(companyId: string): Promise<{ ok: true } | { ok: false; sentence: string }> {
  const { db, user } = await person()
  if (!user) return { ok: false, sentence: SIGN_IN }
  if (!UUID.test(companyId)) return { ok: false, sentence: 'Cello does not have that company.' }
  const { data: own } = await db.from('companies').select('name').eq('id', companyId).eq('user_id', user.id).maybeSingle()
  const name = (own as { name: string } | null)?.name
  if (!name) return { ok: false, sentence: 'Cello does not have that company.' }
  const { data, error } = await db.from('companies').delete().eq('id', companyId).eq('user_id', user.id).select('id')
  if (error || (data ?? []).length === 0) return { ok: false, sentence: REMOVE_REFUSED(name) }
  return { ok: true }
}
