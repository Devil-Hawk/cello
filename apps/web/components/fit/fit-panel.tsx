'use client'

import Link from 'next/link'
import { Check, Loader2, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { chanceLabel } from '@/lib/scoring/read'
import type { RoleFit } from '@/lib/scoring/types'
import { cn } from '@/lib/utils'

export interface FitPanelProps {
  fit: RoleFit | null
  /** Offered when the role has not been assessed yet. */
  onAssess?: () => void
  assessing?: boolean
  /** Why assessing cannot run right now (no resume, no key), shown instead of the button. */
  assessDisabledReason?: string | null
  className?: string
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/**
 * What Cello concluded about one role, in the person's terms: the stated facts it
 * breaks (if any), why they might want it, and their chance with the resume line
 * behind every requirement that is met and a named gap for every one that is not.
 */
export function FitPanel({ fit, onAssess, assessing = false, assessDisabledReason = null, className }: FitPanelProps) {
  if (fit && fit.blocked.length > 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <Section title="Filtered out">
          <ul className="space-y-1.5">
            {fit.blocked.map((b) => (
              <li key={b.text} className="text-body">
                {b.text}
              </li>
            ))}
          </ul>
          <Link href="/settings" className="text-caption font-medium text-accent-deep hover:underline">
            Change dealbreakers
          </Link>
        </Section>
      </div>
    )
  }

  const chance = fit?.chance ?? null
  const thin = chance?.label === 'cannot_assess' && chance.checks.length === 0
  if (!fit || !chance || (chance.label === 'cannot_assess' && !thin)) {
    return (
      <div className={cn('space-y-3', className)}>
        {fit?.want?.reason && (
          <Section title="Why you might want it">
            <p className="text-body">{fit.want.reason}</p>
          </Section>
        )}
        <Section title="Your chances">
          <p className="text-body text-muted-foreground">Not assessed yet.</p>
          {assessDisabledReason ? (
            <p className="text-caption text-muted-foreground">{assessDisabledReason}</p>
          ) : onAssess ? (
            <Button type="button" size="sm" variant="outline" onClick={onAssess} disabled={assessing} className="h-11 sm:h-8">
              {assessing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {assessing ? 'Checking' : 'Check my chances'}
            </Button>
          ) : null}
        </Section>
      </div>
    )
  }

  return (
    <div className={cn('space-y-5', className)}>
      {fit.want?.reason && (
        <Section title="Why you might want it">
          <p className="text-body">{fit.want.reason}</p>
        </Section>
      )}
      <Section title={`Your chances: ${chanceLabel(chance)}`}>
        {thin ? (
          <p className="text-body text-muted-foreground">The posting does not list requirements yet, so Cello cannot check your chances.</p>
        ) : (
          <ul className="space-y-2.5">
            {chance.checks.map((c) => (
              <li key={c.requirement} className="flex gap-2.5">
                {c.status === 'met' ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-deep" aria-label="Shown on your resume" />
                ) : (
                  <Minus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label="Not clearly on your resume" />
                )}
                <div className="min-w-0">
                  <p className="text-body">
                    {c.status === 'met' ? c.requirement : c.status === 'partial' ? `Only partly shown: ${c.requirement}` : `Not on your resume: ${c.requirement}`}
                  </p>
                  {c.evidence && (
                    <p className="text-caption text-muted-foreground">
                      &ldquo;{c.evidence.quote}&rdquo;, line {c.evidence.line}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {chance.confirm.length > 0 && (
          <ul className="space-y-1">
            {chance.confirm.map((text) => (
              <li key={text} className="text-caption text-muted-foreground">
                Confirm yourself: {text.charAt(0).toLowerCase() + text.slice(1)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
