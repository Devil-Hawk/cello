'use client'

import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { Key } from '@/components/ui/key'
import { createClient } from '@/lib/supabase/client'
import { RESUME_UPLOAD_ACCEPT } from '@/lib/resume/import/formats'
import { READ_FAILED, THIN_LINE, nameFromResume, readLine, readResume, type ResumeRead } from './logic'

// Screen 1: the resume and the name. Paste it, or upload a PDF, Word file or
// text file. The words counted are the words read, by code.
export function ResumeScreen({
  initialName,
  hasResume,
  onDone,
}: {
  initialName: string
  hasResume: boolean
  onDone: (name: string) => void
}) {
  const supabase = createClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [name, setName] = useState(initialName)
  const [read, setRead] = useState<ResumeRead | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function finishRead(plain: string) {
    const summary = readResume(plain)
    setRead(summary)
    if (!name.trim()) setName(nameFromResume(plain))
  }

  async function submit(body: FormData | string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/resume/upload', {
        method: 'POST',
        ...(typeof body === 'string'
          ? { headers: { 'Content-Type': 'application/json' }, body }
          : { body }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setError(typeof body === 'string' ? (data?.error ?? READ_FAILED) : READ_FAILED)
        return
      }
      if (typeof body === 'string') {
        await finishRead(text)
      } else {
        const { data: auth } = await supabase.auth.getUser()
        const { data } = auth.user
          ? await supabase.from('profiles').select('resume_text').eq('id', auth.user.id).maybeSingle()
          : { data: null }
        await finishRead((data?.resume_text as string | null) ?? '')
      }
    } catch {
      setError(READ_FAILED)
    } finally {
      setBusy(false)
    }
  }

  async function next() {
    const clean = name.trim()
    if (clean) {
      const { data: auth } = await supabase.auth.getUser()
      if (auth.user) await supabase.from('profiles').update({ full_name: clean }).eq('id', auth.user.id)
    }
    onDone(clean)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="r-section">Start with your resume</h2>
        <p className="r-body mt-2 text-r-ink-2">Paste it, or upload a PDF, Word file or text file.</p>
      </div>

      <div className="space-y-3">
        <label htmlFor="resume-text" className="sr-only">
          Resume text
        </label>
        <textarea
          id="resume-text"
          className="r-field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste your resume here"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Key onClick={() => submit(JSON.stringify({ text }))} disabled={busy || !text.trim()}>
            {busy ? 'Reading' : 'Read it'}
          </Key>
          <input
            ref={fileRef}
            type="file"
            accept={RESUME_UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const form = new FormData()
              form.append('resume', f)
              void submit(form)
            }}
          />
          <Key variant="raised" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="h-[18px] w-[18px]" aria-hidden />
            Upload a file
          </Key>
        </div>
        {error && (
          <p role="alert" className="r-body text-r-ink">
            {error}
          </p>
        )}
      </div>

      {read && (
        <div className="space-y-2" aria-live="polite">
          <p className="r-body">{readLine(read)}</p>
          {read.thin && (
            <p className="r-body text-r-ink-2">
              {THIN_LINE}{' '}
              <button type="button" className="underline underline-offset-4" onClick={() => document.getElementById('resume-text')?.focus()}>
                Add more
              </button>
            </p>
          )}
        </div>
      )}

      {(read || hasResume) && (
        <div className="space-y-1.5">
          <label htmlFor="full-name" className="r-meta">
            Your name
          </label>
          <input id="full-name" className="r-field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
      )}

      <div className="flex items-center gap-3">
        <Key onClick={next} disabled={busy || (!read && !hasResume)}>
          Next
        </Key>
      </div>
    </div>
  )
}
