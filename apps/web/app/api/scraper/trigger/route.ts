import { NextRequest, NextResponse } from 'next/server'
import { withTrace } from '@/lib/trace/spans'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { makeSupabaseAtsStore } from '@/lib/ats/store'
import { staticFetchPage } from '@/lib/ingest/fetch-page'
import { ingestCompany, type DueCompany, type FailureReason } from '@/lib/ingest/run'
import { loadTargets } from '@/lib/ingest/reader/targets'
import { firstTickAtOrAfter } from '@/lib/companies/roles-status'

// The in-app twin of the scheduled check, for one company: the job board when it
// has one, else the one reader (lib/ingest/reader). It is the same code the
// schedule runs (lib/ingest/run.ts), so a company reads the same either way.
// Nothing here calls a model: the tiers that run while a person waits need only
// plain requests, and a page that needs a browser and a model is read by the
// scheduled check.
//
// Vercel has no browser, so this reads with plain requests only (the board, the
// site's own search, its sitemaps, its server-rendered lists); a page that only
// shows its list to a browser is read by the scheduled check, and until then the
// answer says Cello is reading the site and when the next check is.

export const maxDuration = 60

const REASON_MESSAGE: Record<FailureReason, string> = {
  board_error: 'Its job board did not respond. Try again in a few minutes.',
  fetch_failed: 'Its careers page did not load.',
  page_unconfirmed: 'No roles on its careers page could be confirmed. The scheduled check reads pages that need a browser.',
  model_unavailable: 'Its careers page needs reading and no free model could be used.',
  model_limit: "Today's reading limit was reached.",
  bot_check: 'Its site asks visitors to pass a bot check, and Cello does not do that.',
  login_required: 'Its careers site needs a login, so Cello cannot read it.',
  robots: 'Its robots.txt asks automated readers to stay away from its careers pages, so Cello does not read them.',
  no_roles: 'No open roles were found on its careers site.',
  unreachable: 'Its careers site did not answer. Try again in a few minutes.',
  role_pages: 'Its site lists roles, but their pages cannot be read without a browser. Cello will not report them as no roles.',
  render_failed: "Cello's browser could not read its careers page just now. The next scheduled check tries again.",
  time: 'Not reached this time.',
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const companyId = typeof body?.companyId === 'string' ? body.companyId : ''
  if (!companyId) {
    return NextResponse.json({ error: 'Company ID required' }, { status: 400 })
  }

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .eq('user_id', user.id)
    .single()

  if (companyError || !company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  }

  const admin = createAdminClient()

  const targets = await loadTargets(supabase, user.id)
  const outcome = await withTrace(admin, user.id, { name: 'find-new-roles', outputOf: () => ({ companies: 1 }) }, () =>
    ingestCompany(makeSupabaseAtsStore(supabase, { lockClient: admin }), company as DueCompany, {
      fetchPage: staticFetchPage,
      model: null,
      mode: 'inline',
      targets,
    })
  )

  const { result, failure } = outcome
  if (result.busy) {
    return NextResponse.json({
      success: true,
      company: company.name,
      jobsFound: 0,
      inserted: 0,
      reason: null,
      message: `${company.name} is already being checked; its roles will appear in a few minutes.`,
    })
  }

  const TIER_WORDS: Record<string, string> = {
    board: 'its job board',
    site_search: "its site's own search",
    sitemap: 'its sitemap',
    listing: 'its careers page',
    rendered: 'its careers page',
    model: 'its careers page',
  }
  const nextTick = new Date(firstTickAtOrAfter(Date.now())).toISOString().slice(11, 16)
  const message = outcome.message
    ? outcome.message
    : outcome.reading
      ? `Cello is reading this site. Next check around ${nextTick} UTC.`
      : failure
        ? REASON_MESSAGE[failure]
        : result.found > 0
          ? `Found ${result.found} jobs at ${company.name} through ${TIER_WORDS[outcome.tier ?? 'board'] ?? 'its careers page'}`
          : outcome.skipped
            ? 'This company has no careers page to read. Add its careers URL.'
            : `No open roles found at ${company.name}.`

  return NextResponse.json({
    success: !failure,
    company: company.name,
    jobsFound: result.found,
    inserted: result.inserted,
    updated: result.updated,
    closed: result.closed,
    tier: outcome.tier,
    reading: outcome.reading,
    reason: failure,
    message,
  })
}
