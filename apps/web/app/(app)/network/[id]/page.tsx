import type { SupabaseClient } from '@supabase/supabase-js'
import { notFound, redirect } from 'next/navigation'
import { PersonPage } from '@/components/network/person'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { canRemember, recall } from '@/lib/network/memory'
import { getPerson } from '@/lib/network/people'
import { ruleLine } from '@/lib/network/nudges'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Person' }

export default async function Page({ params }: { params: { id: string } }) {
  const client = await createClient()
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) redirect('/login')
  // the tables here are newer than the generated types
  const supabase = client as unknown as SupabaseClient
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) notFound()
  const person = await getPerson(supabase, user.id, params.id)
  if (!person) notFound()

  const [rule, memories, draft, apps, remembers] = await Promise.all([
    ruleLine(supabase, user.id, params.id),
    recall(createAdminClient(), user.id, { contactId: params.id }).catch(() => []),
    supabase.from('outreach_messages').select('id').eq('user_id', user.id).eq('contact_id', params.id).eq('kind', 'follow_up').eq('status', 'pending_review').limit(1).maybeSingle(),
    supabase.from('applications').select('id, jobs(id, title, companies(name))').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(50),
    canRemember(createAdminClient(), user.id).catch(() => false),
  ])
  const applications = ((apps.data ?? []) as unknown as { id: string; jobs: { id: string; title: string; companies: { name: string } | null } | null }[]).map((a) => ({ id: a.id, roleId: a.jobs?.id ?? null, title: a.jobs?.title ?? 'A role', company: a.jobs?.companies?.name ?? '' }))

  return (
    <PersonPage
      person={person}
      memories={memories}
      rule={{ line: rule.line, own: rule.own as Record<string, unknown> | null, global: rule.global }}
      draftId={(draft.data as { id: string } | null)?.id ?? null}
      applications={applications}
      canRemember={remembers}
    />
  )
}
