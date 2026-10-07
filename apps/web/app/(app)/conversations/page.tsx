'use client'

import { useCallback, useEffect, useState } from 'react'
import { ConversationsView } from '@/components/queue/conversations-view'
import type { OutreachRow } from '@/components/queue/outreach-card'
import type { ConversationsData } from '@/lib/network/conversations'
import type { DueNudge } from '@/lib/network/nudges'
import { callCommand } from '@/lib/network/client'

// Conversations: who is waiting on me, what should I send, who could I write to.
export default function ConversationsPage() {
  const [data, setData] = useState<ConversationsData | null>(null)
  const [outreach, setOutreach] = useState<OutreachRow[]>([])
  const [due, setDue] = useState<DueNudge[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cap, setCap] = useState(10)
  const [focusDraft, setFocusDraft] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [c, o, n] = await Promise.all([
        fetch('/api/conversations'),
        fetch('/api/outreach?limit=100'),
        callCommand<{ due: DueNudge[] }>('/api/network', 'network.nudges', {}).catch(() => ({ due: [] as DueNudge[] })),
      ])
      if (!c.ok) throw new Error(String(c.status))
      setData((await c.json()) as ConversationsData)
      const od = await o.json().catch(() => ({}))
      if (Array.isArray(od.messages)) setOutreach(od.messages as OutreachRow[])
      if (typeof od.dailyCap === 'number') setCap(od.dailyCap)
      setDue(n.due)
      setError(null)
    } catch {
      setError('Could not read your conversations. Try again.')
    }
  }, [])

  useEffect(() => {
    void load()
    setFocusDraft(new URLSearchParams(window.location.search).get('draft'))
  }, [load])

  async function handled(messageId: string) {
    // clear at once; the next read brings it back if the save failed
    setData((d) => (d ? { ...d, replies: d.replies.filter((r) => r.id !== messageId), recruiters: d.recruiters.filter((r) => r.id !== messageId) } : d))
    try {
      await callCommand('/api/conversations', 'conversations.handled', { message_id: messageId })
    } catch {
      await load()
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const sentToday = outreach.filter((m) => m.status === 'sent' && (m.sent_at ?? '').slice(0, 10) === today).length

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-8 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="r-display">Conversations</h1>
      </header>
      {error ? (
        <p className="r-body" role="alert">{error} <button type="button" className="underline" onClick={load}>Try again</button></p>
      ) : data === null ? (
        <p className="r-meta">Reading.</p>
      ) : (
        <ConversationsView data={data} outreach={outreach} due={due} gmailConnected={data.gmailConnected} limit={{ cap, sentToday }} onHandled={handled} onChanged={load} focusDraft={focusDraft} />
      )}
    </div>
  )
}
