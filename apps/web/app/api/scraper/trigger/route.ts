import { NextRequest, NextResponse } from 'next/server'
import { withTrace } from '@/lib/trace/spans'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { makeSupabaseAtsStore } from '@/lib/ats/store'
import { staticFetchPage } from '@/lib/ingest/fetch-page'
import { makeIngestModelCall, newModelBudget } from '@/lib/ingest/model'
import { ingestCompany, type DueCompany, type FailureReason } from '@/lib/ingest/run'

// The in-app twin of the scheduled check, for one company: the job board when it
// has one, else its careers page. It is the same code the schedule runs
// (lib/ingest/run.ts), so a company reads the same either way. A page that
// declares its postings in structured data is read with no model at all; any
// other page needs the user's own OpenRouter key, and only a free model is ever
// asked. Without a key those pages are reported as not read, never guessed.
//
// Vercel has no browser, so this uses the plain fetcher; a page that only shows
// its list to a browser is read by the scheduled check instead.

/** A model call allowance for one button press. */
const MODEL_CALLS_PER_PRESS = 6

const REASON_MESSAGE: Record<FailureReason, string> = {
  board_error: 'Its job board did not respond. Try again in a few minutes.',
  fetch_failed: 'Its careers page did not load.',
  page_unconfirmed: 'No roles on its careers page could be confirmed. The scheduled check reads pages that need a browser.',
  model_unavailable: 'Its careers page needs reading and no free model could be used. Add an OpenRouter key in Settings.',
  model_limit: "Today's reading limit was reached.",
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

  // The user's own key, for the free model that reads a page with no structured data.
  const { getDecryptedApiKeys } = await import('@/lib/apikeys')
  const apiKeys = await getDecryptedApiKeys(user.id)
  const admin = createAdminClient()
  const budget = newModelBudget(MODEL_CALLS_PER_PRESS)
  const model = apiKeys.openrouter ? makeIngestModelCall(user.id, apiKeys.openrouter, { budget }) : null

  const outcome = await withTrace(admin, user.id, { name: 'find-new-roles', outputOf: () => ({ companies: 1 }) }, () =>
    ingestCompany(makeSupabaseAtsStore(supabase, { lockClient: admin }), company as DueCompany, {
      fetchPage: staticFetchPage,
      model,
      fetchDetail: async (url) => (await staticFetchPage(url)).html,
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

  const message = failure
    ? REASON_MESSAGE[failure]
    : result.found > 0
      ? `Found ${result.found} jobs at ${company.name}`
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
    reason: failure,
    message,
  })
}
