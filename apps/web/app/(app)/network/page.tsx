import type { SupabaseClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { NetworkView } from '@/components/network/network-view'
import { leftOutSentence, type LeftOutCounts } from '@/lib/network/filter'
import { dueNudges, ruleOf } from '@/lib/network/nudges'
import { listPeople } from '@/lib/network/people'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Network' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

// Network: the address is the whole state (view, search, filters, page), so Back returns to where the list was.
export default async function NetworkPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const client = await createClient()
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) redirect('/login')
  // the tables here are newer than the generated types
  const supabase = client as unknown as SupabaseClient

  const view = one(searchParams.view)
  const query = {
    view: (view === 'company' || view === 'map' ? view : 'list') as 'list' | 'company' | 'map',
    q: one(searchParams.q).slice(0, 100),
    kind: one(searchParams.kind),
    address: one(searchParams.address),
    waiting: one(searchParams.waiting) === '1',
    quiet: one(searchParams.quiet) === '1',
    hasApp: one(searchParams.app),
    order: (one(searchParams.order) === 'closest' ? 'closest' : 'last') as 'last' | 'closest',
  }
  const page = Math.max(1, Number.parseInt(one(searchParams.page), 10) || 1)

  const [list, due, { rule }, beats] = await Promise.all([
    listPeople(supabase, user.id, {
      q: query.q,
      kind: query.kind || undefined,
      address: query.address === 'employer' || query.address === 'personal' ? query.address : undefined,
      hasApplication: query.hasApp === 'yes' ? true : query.hasApp === 'no' ? false : undefined,
      waitingOnYou: query.waiting,
      quiet: query.quiet,
      order: query.order,
      page,
    }),
    dueNudges(supabase, user.id).catch(() => []),
    ruleOf(supabase, user.id),
    supabase.from('job_heartbeats').select('job, succeeded_at, found').eq('user_id', user.id).in('job', ['inbox.sync', 'network.sync']),
  ])
  const rows = (beats.data ?? []) as { job: string; succeeded_at: string | null; found: { leftOut?: { counts: LeftOutCounts; addresses: { email: string; rule: string }[] } } | null }[]
  const sync = rows.find((r) => r.job === 'network.sync')
  const left = sync?.found?.leftOut

  return (
    <NetworkView
      people={list.people}
      total={list.total}
      page={list.page}
      pages={list.pages}
      due={due}
      rule={rule}
      leftOutSentence={left ? leftOutSentence(left.counts) : null}
      leftOut={left?.addresses ?? []}
      gmailConnected={rows.some((r) => r.job === 'inbox.sync')}
      gmailRead={!!sync?.succeeded_at}
      query={query}
    />
  )
}
