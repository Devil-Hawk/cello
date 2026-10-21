import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { IDENTIFY } from '@/lib/ats/verify'
import type { AtsProviderId } from '@/lib/ats/types'
import { addCompany, realAddDeps, type AddBy, type AddFailure } from '@/lib/companies/add-link'
import { getEmployer } from '@/lib/companies/directory'
import { ndjson } from '@/lib/companies/ndjson'
import { HANDOFF_LINE, readWithin } from '@/lib/companies/follow'
import { loadPerson, readEmployer } from '@/lib/companies/read-employer'

// POST /api/companies/add   { employerId } | { candidateId } | { link } | { candidate }
//
// Follows an employer the directory has verified, checks a candidate the person chose, reads a pasted careers link and
// verifies whose it is, or proves again and adds a candidate a search found (lib/companies/add-link.ts).
//
// What is known before any network call is plain JSON with its status: 400 for a link Cello will not read or a body it
// does not know, 403 for a demo account, 404 for an employer Cello does not have, 429 for the day's limit, 500 for a
// failure, 200 for an add or a directory hit. The answer becomes NDJSON only at the first network step (reading, or
// board_found for a proven board): one {"step",...} line per real stage as it happens (reading, board_found,
// checking_owner, reading_roles), then one last line: added {employer, read}, refused {reason, line, offers} or
// queued {line}. A check that ends in a reason is an answer, not an error. `read` is {listed, kept}, or null when the
// board could not be read in 8 s; `kept` is null when the person has stated no targets.
//
// ponytail: only adds that succeed count toward the daily limit; add an attempts count if checks are abused.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STATUS: Partial<Record<AddFailure, number>> = { demo: 403, daily_limit: 429, bad_link: 400, not_found: 404, not_saved: 500 }

const UUID = /^[0-9a-f-]{36}$/i

/** A candidate from a search, as the client hands it back. It is only a pointer: the add proves it again. */
function parseCandidate(c: unknown): AddBy | null {
  if (!c || typeof c !== 'object') return null
  const v = c as Record<string, unknown>
  const text = (x: unknown, max: number) => (typeof x === 'string' && x.trim() !== '' && x.length <= max ? x.trim() : null)
  if (typeof v.employerId === 'string') return UUID.test(v.employerId) ? { employerId: v.employerId } : null
  if (typeof v.candidateId === 'string') return UUID.test(v.candidateId) ? { candidateId: v.candidateId } : null
  // The Q-id is all that is taken from a Wikidata profile: the add reads the rest from Wikidata itself.
  const qidOf = (x: unknown) => (typeof x === 'string' && /^Q\d{1,12}$/.test(x) ? x : undefined)
  const qid = qidOf(v.qid) ?? qidOf((v.profile as { qid?: unknown } | null | undefined)?.qid)
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
  return ndjson(
    async (emit) => {
      const result = await addCompany(db, user.id, by, { ...realAddDeps, report: emit })
      if (!result.ok) return emit(result.queued ? { step: 'queued', line: result.queued } : { step: 'refused', reason: result.reason, line: result.line, offers: result.offers })

      // Added: read its board once for this person, so the tile opens with real counts. The read is held to 8 s like a follow's.
      const employer = !result.already && result.employer.employerId ? await getEmployer(db, result.employer.employerId) : null
      let read: { listed: number; kept: number | null } | null = null
      let line = result.already ? 'You follow this already.' : 'Following. Cello checks it with the others, every 6 hours.'
      if (employer?.ats_provider) {
        const people = await loadPerson(db, user.id)
        const first = await readWithin(readEmployer(db, employer, people))
        if (first === 'timeout') line = HANDOFF_LINE
        else if (first && !first.failure) read = { listed: first.listed, kept: people.length > 0 ? first.kept : null }
      }
      emit({ step: 'added', companyId: result.companyId, already: result.already, employer: result.employer, read, line })
    },
    {
      streamFrom: (e) => ['reading', 'board_found'].includes((e as { step?: string }).step ?? ''),
      status: (e) => ((e as { step?: string }).step === 'refused' ? STATUS[(e as { reason: AddFailure }).reason] : undefined) ?? 200,
    }
  )
}
