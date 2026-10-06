'use server'

// What the Companies page does as the signed-in person. Each action names the person from the session; the browser
// never sends who it is. A refusal is a sentence, never a code.

import { isDemoProfile } from '@/lib/access/guardrails'
import { saveCompany } from '@/lib/companies/add'
import { employerDomain, parseLink } from '@/lib/companies/add-link'
import { nameFromDomain } from '@/lib/companies/page-name'
import { rpcSlotStore } from '@/lib/commands/slots'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { checkedAgainLine, type Found } from '@/components/companies/logic'
import { followCompanies, type FollowResult } from './follow.stub'
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
