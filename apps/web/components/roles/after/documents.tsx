'use client'

// The record after acting, group two: the documents Cello made for this role (resume, letter, messages),
// newest first, from the person's own artifacts.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface Doc {
  id: string
  type: string
  title: string
  created_at: string
}

const TYPE_LABEL: Record<string, string> = { resume: 'Resume', cover_letter: 'Cover letter', message: 'Message', note: 'Note' }

export function DocumentsGroup({ jobId }: { jobId: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null)

  useEffect(() => {
    createClient()
      .from('artifacts')
      .select('id, type, title, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setDocs((data as Doc[] | null) ?? []))
  }, [jobId])

  if (!docs || docs.length === 0) return null
  return (
    <section aria-labelledby="after-docs" className="r-sheet space-y-2 p-6">
      <h2 id="after-docs" className="r-title">Documents</h2>
      <ul className="divide-y divide-[var(--r-line)]">
        {docs.map((d) => (
          <li key={d.id} className="py-2">
            <p className="r-name">{d.title}</p>
            <p className="r-meta">{TYPE_LABEL[d.type] ?? d.type}, {new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
