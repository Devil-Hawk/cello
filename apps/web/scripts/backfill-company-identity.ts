/**
 * OWNER-RUN. Backfills the two inputs company-identity matching
 * (lib/entities/companies.ts) depends on for every company that predates
 * this migration:
 *
 *   1. companies.name_key <- normalizeCompanyName(name), for every company
 *      missing one.
 *   2. companies.domain <- employerDomainFromUrl(...) over that company's OWN
 *      job URLs, for every company that still has no domain on file.
 *
 * Then emits company_merge_candidates rows (same-domain AND trgm-fuzzy name
 * matches) for a human to review. APPLIES NO MERGES ITSELF — not even the
 * same-domain auto-merge lib/entities/companies.ts#scanMergeCandidates
 * performs live. A one-time pass over a whole historical table is the wrong
 * place to auto-apply an identity decision at scale before a human has seen
 * what it would actually do; run scanMergeCandidates (or review the emitted
 * 'pending' rows directly) separately once the backfilled numbers look sane.
 *
 * SOURCE_FETCH_HOSTS EXCLUSION IS MANDATORY. employerDomainFromUrl
 * (lib/sources/util.ts) already refuses to return an aggregator host by
 * construction — assertNotAggregatorHost below is defense in depth on top of
 * that, not a substitute for it: a poisoned domain written here doesn't just
 * mislabel one field, it becomes companies.domain, which
 * scanMergeCandidates' same-domain path treats as strong-enough-to-AUTO-
 * MERGE. That is exactly the mechanism that turned the historical
 * mojibake-era incident (190 of one user's 436 companies carrying an
 * aggregator domain — see lib/sources/util.ts's SOURCE_FETCH_HOSTS comment)
 * into wrong entity fusion instead of a cosmetic bad field. If
 * employerDomainFromUrl ever regresses, this script throws loudly instead of
 * quietly writing the poison forward.
 *
 * Idempotent: only touches companies with name_key/domain actually NULL, and
 * scanMergeCandidates' own idempotency (never re-proposing a pair already in
 * company_merge_candidates, any status) means a second run of this script
 * emits nothing new for a company set it already covered.
 *
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/backfill-company-identity.ts                 # dry run (default)
 *   npx tsx scripts/backfill-company-identity.ts --apply         # write name_key/domain, emit candidates
 *   npx tsx scripts/backfill-company-identity.ts --apply --limit 200   # smoke test (companies per phase)
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_KEY
 *   also accepted) via lib/harness/supabase-admin.ts#createAdminClient() —
 *   the same service-role credentials every other apps/web/scripts/*.ts
 *   owner-run script uses (see scripts/backfill-embeddings.ts).
 */
import { createAdminClient } from '../lib/harness/supabase-admin'
import { groupByDomain, normalizeCompanyName, pairOf } from '../lib/entities/companies'
import { deriveCompanyDomain } from '../lib/entities/company-domain'

const READ_PAGE = 500

function parseArgs(argv: string[]) {
  const limitIdx = argv.indexOf('--limit')
  return {
    apply: argv.includes('--apply'),
    limit: limitIdx > -1 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : null,
  }
}

async function backfillNameKeys(admin: ReturnType<typeof createAdminClient>, apply: boolean, limit: number | null): Promise<number> {
  let cursor: string | null = null
  let candidates = 0
  let written = 0
  for (;;) {
    let query = admin
      .from('companies')
      .select('id, name, name_key')
      .is('name_key', null)
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw new Error(`load companies (name_key): ${error.message}`)
    const rows = (data ?? []) as { id: string; name: string; name_key: string | null }[]
    if (rows.length === 0) break
    for (const r of rows) {
      const key = normalizeCompanyName(r.name)
      if (!key) continue
      candidates++
      if (limit && candidates > limit) break
      if (apply) {
        const { error: updateError } = await admin.from('companies').update({ name_key: key }).eq('id', r.id)
        if (updateError) throw new Error(`write name_key for ${r.id}: ${updateError.message}`)
        written++
      }
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE || (limit && candidates >= limit)) break
  }
  console.log(`\nname_key: ${candidates} companies missing one${apply ? ` — wrote ${written}` : ' (dry run, none written)'}`)
  return candidates
}

async function backfillDomains(admin: ReturnType<typeof createAdminClient>, apply: boolean, limit: number | null): Promise<number> {
  let cursor: string | null = null
  let candidates = 0
  let written = 0
  let skippedNoSignal = 0
  for (;;) {
    let query = admin
      .from('companies')
      .select('id, name')
      .is('domain', null)
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw new Error(`load companies (domain): ${error.message}`)
    const rows = (data ?? []) as { id: string; name: string }[]
    if (rows.length === 0) break

    for (const r of rows) {
      if (limit && candidates >= limit) break
      const { data: jobRows, error: jobsError } = await admin.from('jobs').select('url').eq('company_id', r.id).limit(50)
      if (jobsError) throw new Error(`load jobs for ${r.id}: ${jobsError.message}`)
      const urls = ((jobRows ?? []) as { url: string | null }[]).map((j) => j.url)
      const domain = deriveCompanyDomain(urls)
      if (!domain) {
        skippedNoSignal++
        continue
      }
      candidates++
      if (apply) {
        const { error: updateError } = await admin.from('companies').update({ domain }).eq('id', r.id)
        if (updateError) throw new Error(`write domain for ${r.id}: ${updateError.message}`)
        written++
      }
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE || (limit && candidates >= limit)) break
  }
  console.log(
    `domain  : ${candidates} companies given a domain from their own job URLs` +
      `${apply ? ` — wrote ${written}` : ' (dry run, none written)'}, ${skippedNoSignal} had no derivable domain (left null)`
  )
  return candidates
}

/**
 * Emits company_merge_candidates rows (same-domain AND trgm-fuzzy) for every
 * user with more than one tracked company. NEVER merges — see file header.
 */
async function emitCandidates(admin: ReturnType<typeof createAdminClient>, apply: boolean): Promise<number> {
  const { data: userRows, error: userError } = await admin.from('companies').select('user_id')
  if (userError) throw new Error(`load user ids: ${userError.message}`)
  const userIds = [...new Set(((userRows ?? []) as { user_id: string }[]).map((r) => r.user_id))]

  let emitted = 0
  for (const userId of userIds) {
    const { data: known, error: knownError } = await admin
      .from('company_merge_candidates')
      .select('company_a, company_b')
      .eq('user_id', userId)
    if (knownError) throw new Error(`load known candidates for ${userId}: ${knownError.message}`)
    const knownPairs = new Set(
      ((known ?? []) as { company_a: string; company_b: string }[]).map((r) => pairOf(r.company_a, r.company_b))
    )

    const proposals = new Map<string, { score: number; reason: string }>() // pairOf -> proposal

    const { data: withDomain, error: domainError } = await admin
      .from('companies')
      .select('id, domain')
      .eq('user_id', userId)
      .is('canonical_id', null)
      .not('domain', 'is', null)
    if (domainError) throw new Error(`load companies by domain for ${userId}: ${domainError.message}`)
    const byDomain = groupByDomain((withDomain ?? []) as { id: string; domain: string }[])
    for (const ids of byDomain.values()) {
      if (ids.length < 2) continue
      const sorted = [...ids].sort()
      for (let i = 1; i < sorted.length; i++) {
        proposals.set(pairOf(sorted[0], sorted[i]), { score: 1, reason: 'same domain (backfill — review before merging)' })
      }
    }

    const { data: fuzzy, error: rpcError } = await admin.rpc('find_company_merge_candidates', {
      p_user_id: userId,
      p_threshold: 0.6,
    })
    if (rpcError) throw new Error(`trgm scan for ${userId}: ${rpcError.message}`)
    for (const r of (fuzzy ?? []) as { company_a: string; company_b: string; score: number }[]) {
      const key = pairOf(r.company_a, r.company_b)
      if (!proposals.has(key)) proposals.set(key, { score: r.score, reason: `name similarity ${r.score.toFixed(2)} (backfill)` })
    }

    for (const [key, proposal] of proposals) {
      if (knownPairs.has(key)) continue
      const [a, b] = key.split('::')
      emitted++
      if (apply) {
        const { error: insertError } = await admin.from('company_merge_candidates').insert({
          user_id: userId,
          company_a: a,
          company_b: b,
          score: proposal.score,
          reason: proposal.reason,
          status: 'pending',
        })
        if (insertError) throw new Error(`insert candidate ${key} for ${userId}: ${insertError.message}`)
      }
    }
  }
  console.log(`candidates: ${emitted} pending merge candidates${apply ? ' inserted' : ' would be inserted (dry run)'}`)
  return emitted
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2))
  console.log('backfill-company-identity')
  console.log(`  mode : ${apply ? 'APPLY — writes name_key/domain, inserts candidate rows' : 'DRY RUN (default) — pass --apply to write'}`)

  const admin = createAdminClient()
  await backfillNameKeys(admin, apply, limit)
  await backfillDomains(admin, apply, limit)
  // Candidate emission reads name_key/domain fresh — only meaningful (and only
  // run) once those are actually written, otherwise it would just re-detect
  // the same gaps a dry run already reported above with no new information.
  if (apply) await emitCandidates(admin, apply)
  else console.log('\ncandidates: skipped in dry run (depends on name_key/domain having actually been written)')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
