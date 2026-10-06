'use client'

// A company's card in an answer (directive 43): logo, name, how many roles it has open, how many applications the
// person has there, whether they follow it, and Open. Read from the stored row by lib/chat/cards.ts.

import Link from 'next/link'
import { CompanyLogo } from '@/components/companies/company-logo'
import { buttonVariants } from '@/components/ui/button'
import { chatHref } from '@/lib/chat/links'
import type { CompanyCard as CompanyCardData } from '@/lib/chat/cards'
import { NAME_CLASS } from './role-card'

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function CompanyCard({ card, onOpen }: { card: CompanyCardData; onOpen?: (kind: 'company', id: string) => void }) {
  const href = chatHref('company', card.id)
  const facts = [`${card.openCount} open`, count(card.keptCount, 'application'), card.following && 'Following'].filter(Boolean)
  return (
    <article className="flex items-start gap-3 rounded-card border border-border bg-card p-3" data-card="company" aria-label={card.name}>
      <CompanyLogo src={card.logoUrl} name={card.name} />
      <div className="min-w-0 flex-1">
        <p className={`${NAME_CLASS} break-words`}>{card.name}</p>
        <p className="mt-1 text-caption text-muted-foreground">{facts.join(' · ')}</p>
      </div>
      {onOpen ? (
        <button type="button" className={buttonVariants({ variant: 'outline', size: 'sm' })} onClick={() => onOpen('company', card.id)}>
          Open
        </button>
      ) : (
        href && (
          <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Open
          </Link>
        )
      )}
    </article>
  )
}
