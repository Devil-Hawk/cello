'use client'

// A made thing under the answer that made it: its kind and title, "Version 1", the first lines, and Copy and Open.
// Everything is read from the stored artifact (lib/chat/page-data.ts); Copy fetches the current text when pressed.

import { useState } from 'react'
import { Check, Copy, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { typeWord } from '@/components/chat/side-panel'
import type { MadeInfo } from '@/lib/chat/page-data'

export function MadeBlock({ made, onOpen }: { made: MadeInfo; onOpen: (id: string) => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(made.id)}`)
      const body = (await res.json()) as { versions: { content_text: string }[] }
      await navigator.clipboard.writeText(body.versions[0]?.content_text ?? made.preview)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* the text stays in the panel */
    }
  }
  return (
    <article className="rounded-card border border-border bg-card p-3" data-made={made.type}>
      <p className="flex items-center gap-2 text-caption text-muted-foreground">
        <FileText className="h-4 w-4" aria-hidden />
        <span>
          {typeWord(made.type)} · Version {made.version}
        </span>
      </p>
      <p className="mt-1 break-words text-body font-semibold text-foreground">{made.title}</p>
      {made.type !== 'comparison' && made.preview && <p className="mt-1 line-clamp-6 whitespace-pre-line break-words text-caption text-muted-foreground">{made.preview.replace(/\n{2,}/g, '\n')}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="mr-1 h-4 w-4" aria-hidden /> : <Copy className="mr-1 h-4 w-4" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onOpen(made.id)}>
          Open
        </Button>
      </div>
    </article>
  )
}
