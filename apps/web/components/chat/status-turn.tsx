// One line in the conversation when an application the chat holds moves: the sentence the pipeline wrote for the event
// and a button to open the application. Nothing here comes from a model. A turn whose event cannot be read shows nothing.
// ponytail: only Open for now. Approve and the other buttons need the person's own door (applications.* commands), which
// this page gets with the registry; the button must never act from anything but the person's click.

import Link from 'next/link'
import { chatHref } from '@/lib/chat/links'
import type { StatusLine } from '@/lib/chat/status'

export function StatusTurn({ line }: { line: StatusLine | undefined }) {
  if (!line) return null
  const href = chatHref('application', line.applicationId)
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-border pl-3 text-caption text-muted-foreground" data-status-turn>
      <span className="text-foreground">{line.sentence}</span>
      {href && (
        <Link href={href} className="rounded-control border border-border bg-card px-2 py-0.5 text-foreground hover:bg-muted">
          Open
        </Link>
      )}
    </p>
  )
}
