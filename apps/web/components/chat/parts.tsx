'use client'

// An answer as code passed it: parts, each led by the things it is about, and the card of the turn's subject.
//   - a part about one or a few things leads with their names, so every fact says which role, company, application
//     or person it is about; a part about none has no lead; with a single tile the leads are left out;
//   - the text is Markdown (react-markdown, GFM, sanitized: no raw HTML), and a `cello:` link becomes the page's link;
//   - a card part is drawn from a card code read out of the stored row; a subject that could not be read has none.
// Nothing here decides what is true: it draws what lib/chat/answer.ts already checked.

import { useState } from 'react'
import Link from 'next/link'
import { Check, Copy } from 'lucide-react'
import { Markdown } from '@/components/chat/markdown'
import { CompanyCard } from '@/components/chat/cards/company-card'
import { RoleCard } from '@/components/chat/cards/role-card'
import type { Card } from '@/lib/chat/cards'
import { chatHref, rewriteCelloLinks } from '@/lib/chat/links'
import type { AttachKind, Part } from '@/lib/chat/types'

export interface Named {
  kind: AttachKind
  ref: string
  name: string
}

export interface AnswerPartsProps {
  parts: Part[]
  /** Names of the things parts are about: the tiles held now and ones since removed. */
  names: Named[]
  /** How many tiles the chat holds. With one, the leads are left out. */
  tileCount: number
  /** Cards code read from stored rows, for the card parts. */
  cards: Card[]
  /** Opens a made thing, or a record, in the side panel. */
  onOpen?: (kind: AttachKind, ref: string) => void
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => undefined
        )
      }}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      <span className="sr-only">{copied ? 'Copied' : label}</span>
    </button>
  )
}

function Lead({ about, names, onOpen }: { about: { kind: AttachKind; ref: string }[]; names: Named[]; onOpen?: AnswerPartsProps['onOpen'] }) {
  return (
    <p className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-caption font-medium text-foreground" data-lead>
      {about.map((a) => {
        const name = names.find((n) => n.kind === a.kind && n.ref === a.ref)?.name
        const href = chatHref(a.kind, a.ref)
        const label = name ?? 'No longer listed'
        const cls = 'rounded-control bg-muted px-2 py-0.5'
        if (!name) return <span key={`${a.kind}:${a.ref}`} className={`${cls} text-muted-foreground`}>{label}</span>
        return href ? (
          <Link key={`${a.kind}:${a.ref}`} href={href} className={`${cls} hover:underline`}>
            {label}
          </Link>
        ) : (
          <button key={`${a.kind}:${a.ref}`} type="button" className={`${cls} hover:underline`} onClick={() => onOpen?.(a.kind, a.ref)}>
            {label}
          </button>
        )
      })}
    </p>
  )
}

export function AnswerParts({ parts, names, tileCount, cards, onOpen }: AnswerPartsProps) {
  const shown = new Set<string>()
  return (
    <div className="space-y-4">
      {parts.map((part, i) => {
        if ('card' in part) {
          const id = `${part.card.kind}:${part.card.ref}`
          const card = cards.find((c) => c.kind === part.card.kind && c.id === part.card.ref)
          // One card for each subject, and none when the row could not be read.
          if (!card || shown.has(id)) return null
          shown.add(id)
          return card.kind === 'role' ? <RoleCard key={i} card={card} onOpen={onOpen && ((_, ref) => onOpen('role', ref))} /> : <CompanyCard key={i} card={card} onOpen={onOpen && ((_, ref) => onOpen('company', ref))} />
        }
        return (
          <section key={i} className="group">
            {tileCount > 1 && part.about.length > 0 && <Lead about={part.about} names={names} onOpen={onOpen} />}
            <Markdown content={rewriteCelloLinks(part.text)} />
            <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
              <CopyButton text={part.text} />
            </div>
          </section>
        )
      })}
    </div>
  )
}
