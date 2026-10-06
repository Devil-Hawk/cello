'use client'

// The quick chat every page can show: one line, "Chat about this", that opens a new chat with what the person is
// looking at attached and their words in the compose box. It shows only where Chat is open for the person.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUp } from 'lucide-react'

export type QuickChatProps = {
  /** The thing the person is looking at, attached to the chat as its first tile. */
  about?: { kind: string; ref: string }
}

/** Where a quick chat goes: /chat with the words in the compose box and the thing as a chip. Null for no words. */
export function quickChatHref(text: string, about?: QuickChatProps['about']): string | null {
  const ask = text.trim().slice(0, 2000)
  if (!ask) return null
  const q = new URLSearchParams({ ask })
  if (about) q.set('about', `${about.kind}:${about.ref}`)
  return `/chat?${q.toString()}`
}

export function QuickChat({ about }: QuickChatProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  // Chat answers 404 while it is closed for this person; then there is nothing to show.
  useEffect(() => {
    let live = true
    fetch('/api/chat?limit=1', { cache: 'no-store' })
      .then((res) => live && setOpen(res.ok))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  if (!open) return null
  return (
    <form
      className="flex items-center gap-2 rounded-card border border-input bg-card p-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        const href = quickChatHref(text, about)
        if (href) router.push(href)
      }}
    >
      <input aria-label="Chat about this" value={text} onChange={(e) => setText(e.target.value)} placeholder="Chat about this" maxLength={2000} className="min-w-0 flex-1 bg-transparent px-2 py-1 text-body text-foreground placeholder:text-muted-foreground focus:outline-none" />
      <button type="submit" aria-label="Start a chat" disabled={!text.trim()} className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40">
        <ArrowUp className="h-4 w-4" aria-hidden />
      </button>
    </form>
  )
}
