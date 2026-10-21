import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { IDENTIFY } from '@/lib/ats/verify'
import type { AtsProviderId } from '@/lib/ats/types'
import { addCompany, realAddDeps, type AddBy } from '@/lib/companies/add-link'
import { getEmployer } from '@/lib/companies/directory'
import { ndjson } from '@/lib/companies/ndjson'
import { loadPerson, readEmployer } from '@/lib/companies/read-employer'

// POST /api/companies/add   { employerId } | { candidateId } | { link } | { candidate }
//
// Follows an employer the directory has verified, checks a candidate the person chose, reads a pasted careers link and
// verifies whose it is, or proves again and adds a candidate a search found (lib/companies/add-link.ts).
//
// The answer is NDJSON, one {"step",...} line per real stage as it happens: directory_hit, reading, board_found,
// checking_owner, reading_roles, then one last line: added {employer, read: {listed, kept}}, refused {reason, line, offers}
// or queued {line}. A check that ends in a reason is an answer, not an error. Refusals before the stream starts (not
// signed in, cross-site, a body that is not one of the above) are plain JSON with their status; once it has started the
// status is 200 and the last line says how it ended.
//
// ponytail: only adds that succeed count toward the daily limit; add an attempts count if checks are abused.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID = /^[0-9a-f-]{36}$/i

/** A candidate from a search, as the client hands it back. It is only a pointer: the add proves it again. */
function parseCandidate(c: unknown): AddBy | null {
  if (!c || typeof c !== 'object') return null
  const v = c as Record<string, unknown>
  const text = (x: unknown, max: number) => (typeof x === 'string' && x.trim() !== '' && x.length <= max ? x.trim() : null)
  if (typeof v.employerId === 'string') return UUID.test(v.employerId) ? { employerId: v.employerId } : null
  if (typeof v.candidateId === 'string') return UUID.test(v.candidateId) ? { candidateId: v.candidateId } : null
  const qid = typeof v.qid === 'string' && /^Q\d{1,12}$/.test(v.qid) ? v.qid : undefined
  const name = text(v.name, 200)
  if (typeof v.provider === 'string' && typeof v.token === 'string') {
    const domain = v.domain == null ? null : text(v.domain, 253)?.toLowerCase() ?? null
    const ok = name && v.provider in IDENTIFY && /^[A-Za-z0-9._-]{1,128}$/.test(v.token) && (v.domain == null || domain)
    return ok ? { board: { provider: v.provider as AtsProviderId, token: v.token, name, domain, qid } } : null
  }
  const domain = text(v.domain, 253)?.toLowerCase()
  const careersUrl = text(v.careersUrl, 2000)
  return domain && careersUrl ? { site: { domain, careersUrl, ...(name ? { name } : {}), qid } } : null
}

function parseBody(body: unknown): AddBy | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const given = (['employerId', 'candidateId', 'link', 'candidate'] as const).filter((k) => (k === 'candidate' ? b[k] != null : typeof b[k] === 'string' && (b[k] as string).trim() !== ''))
  if (given.length !== 1) return null
  const key = given[0]
  if (key === 'candidate') return parseCandidate(b.candidate)
  const value = (b[key] as string).trim()
  if (key === 'link') return value.length <= 2000 ? { link: value } : null
  return UUID.test(value) ? ({ [key]: value } as AddBy) : null
}

export async function POST(request: NextRequest) {
  if (isCrossSiteRequest(request.headers)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const by = parseBody(await request.json().catch(() => null))
  if (!by) return NextResponse.json({ error: 'Send one of employerId, candidateId, link or candidate.' }, { status: 400 })

  const db = createAdminClient()
  return ndjson(async (emit) => {
    const result = await addCompany(db, user.id, by, { ...realAddDeps, report: emit })
    if (!result.ok) return emit(result.queued ? { step: 'queued', line: result.queued } : { step: 'refused', reason: result.reason, line: result.line, offers: result.offers })

    // Added: read its board once for this person, so the tile opens with real counts.
    const employer = !result.already && result.employer.employerId ? await getEmployer(db, result.employer.employerId) : null
    const read = employer?.ats_provider ? await readEmployer(db, employer, await loadPerson(db, user.id)).then((r) => ({ listed: r.listed, kept: r.kept }), () => null) : null
    emit({ step: 'added', companyId: result.companyId, already: result.already, employer: result.employer, read, line: result.already ? 'You follow this already.' : 'Following. Cello checks it with the others, every 6 hours.' })
  })
}
