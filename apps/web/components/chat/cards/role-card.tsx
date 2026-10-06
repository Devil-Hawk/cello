'use client'

// A role's card in an answer (directive 43): logo, the title as large as the company's name, place, chance, pay as the
// posting states it, the person's state, and Open. Every value is read from the stored row by lib/chat/cards.ts and
// passed in; nothing here comes from model text, and a field with no stored value is left out.

import Link from 'next/link'
import { CompanyLogo } from '@/components/companies/company-logo'
import { buttonVariants } from '@/components/ui/button'
import { chatHref } from '@/lib/chat/links'
import type { RoleCard as RoleCardData } from '@/lib/chat/cards'
import { cn } from '@/lib/utils'

export const CHANCE_WORDS = { strong: 'Strong', possible: 'Possible', stretch: 'Stretch' } as const

const STATE_WORDS: Record<string, string> = {
  discovered: 'Saved',
  applied: 'Applied',
  screen: 'Screening',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Closed',
  withdrawn: 'Closed',
  closed: 'Closed',
}
export const stateWord = (stage: string) => STATE_WORDS[stage] ?? `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`

/** The same classes for the title and the company, so a role is as visible as its employer. */
export const NAME_CLASS = 'text-body font-semibold leading-snug text-foreground'

export function RoleCard({ card, onOpen }: { card: RoleCardData; onOpen?: (kind: 'role', id: string) => void }) {
  const href = chatHref('role', card.id)
  const facts = [card.place, card.chance && `Chance: ${CHANCE_WORDS[card.chance]}`, card.pay && `Pay as stated: ${card.pay}`, card.state && stateWord(card.state)].filter(Boolean)
  return (
    <article className="flex items-start gap-3 rounded-card border border-border bg-card p-3" data-card="role" aria-label={`${card.title}${card.company ? ` at ${card.company}` : ''}`}>
      <CompanyLogo src={card.logoUrl} name={card.company ?? card.title} />
      <div className="min-w-0 flex-1">
        <p className={cn(NAME_CLASS, 'break-words')}>{card.title}</p>
        {card.company && <p className={cn(NAME_CLASS, 'break-words')}>{card.company}</p>}
        {facts.length > 0 && <p className="mt-1 text-caption text-muted-foreground">{facts.join(' · ')}</p>}
      </div>
      {onOpen ? (
        <button type="button" className={buttonVariants({ variant: 'outline', size: 'sm' })} onClick={() => onOpen('role', card.id)}>
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
