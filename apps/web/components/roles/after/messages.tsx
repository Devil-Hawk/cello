'use client'

// The record after acting, group three: the mail about this application, newest first, each with who wrote and
// when. The first lines are the stored excerpt; the person's page in Network holds the whole conversation.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { ago } from '@/lib/network/format'

interface Msg {
  id: string
  direction: 'in' | 'out'
  sent_at: string
  subject: string
  excerpt: string | null
  contact_id: string | null
}

export function MessagesGroup({ jobId }: { jobId: string }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null)

  useEffect(() => {
    // messages is newer than the generated types
    const db = createClient() as unknown as SupabaseClient
    db.from('applications')
      .select('id')
      .eq('job_id', jobId)
      .maybeSingle()
      .then(async ({ data }) => {
        const id = (data as { id: string } | null)?.id
        if (!id) return setMsgs([])
        const r = await db.from('messages').select('id, direction, sent_at, subject, excerpt, contact_id').eq('application_id', id).order('sent_at', { ascending: false }).limit(30)
        setMsgs((r.data as Msg[] | null) ?? [])
      })
  }, [jobId])

  if (!msgs || msgs.length === 0) return null
  return (
    <section aria-labelledby="after-msgs" className="r-sheet space-y-2 p-6">
      <h2 id="after-msgs" className="r-title">Messages</h2>
      <ul className="divide-y divide-[var(--r-line)]">
        {msgs.map((m) => (
          <li key={m.id} className="py-2">
            <p className="r-name">{m.subject || 'No subject'}</p>
            <p className="r-meta">
              {m.direction === 'out' ? 'You wrote' : 'They wrote'} {ago(m.sent_at)}
              {m.contact_id && (
                <>
                  {'. '}
                  <Link href={`/network/${m.contact_id}`} className="underline">Open the person</Link>
                </>
              )}
            </p>
            {m.excerpt && <p className="r-body whitespace-pre-line">{m.excerpt}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
