'use client'

// What the last "Find contacts" run actually searched.
//
// WHY THIS EXISTS
//   This panel used to answer every empty run with one hard-coded sentence —
//   "No new contacts found — nothing usable in the job posting or company
//   research yet" — which was indistinguishable from a broken button and
//   quietly hid the fact that barely anything was being searched.
//   POST /api/contacts/source already returns a SearchReport naming every
//   source consulted, how much of it was read, and why it came up empty
//   (lib/contacts/sources.ts). This renders that, verbatim where it can:
//   `headline` is written as a full sentence for exactly this purpose.
//
//   The per-source detail is a <details> disclosure rather than always-on
//   prose (the convention used by components/charts/accessible-figure.tsx and
//   components/settings/mcp-tab.tsx): the headline answers "did it work", the
//   list answers "then why not", and only the second one is a wall of text.

import type { SearchReport, SearchStepStatus } from '@/lib/contacts/sources'
import { cn } from '@/lib/utils'

/** The status vocabulary from components/ui/panel.tsx: pipeline tones, never raw utility colours. */
const STATUS_DOT: Record<SearchStepStatus, string> = {
  found: 'bg-pipeline-offer',
  empty: 'bg-muted-foreground/40',
  skipped: 'bg-muted-foreground/25',
  error: 'bg-pipeline-rejected',
}

const STATUS_LABEL: Record<SearchStepStatus, string> = {
  found: 'found',
  empty: 'nothing found',
  skipped: 'not searched',
  error: 'search failed',
}

export function ContactSearchReport({ report }: { report: SearchReport }) {
  const sourceCount = report.steps.length

  return (
    <div className="space-y-1.5">
      <p className="text-caption text-foreground">{report.headline}</p>

      {sourceCount > 0 && (
        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-caption font-medium text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            What was searched ({sourceCount} source{sourceCount === 1 ? '' : 's'})
          </summary>
          <ul className="mt-2 space-y-2">
            {report.steps.map((step, i) => (
              <li key={`${step.key}-${i}`} className="flex gap-2">
                <span
                  className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[step.status])}
                  aria-hidden
                />
                <div className="min-w-0 text-caption">
                  <p className="text-foreground">
                    {step.label}
                    {/* `scanned` is the honest volume claim — how much was actually
                        read, not how much exists. Shown next to the label so
                        "0 found" can never be mistaken for "nothing was tried". */}
                    {step.scanned && <span className="text-muted-foreground"> · {step.scanned}</span>}
                    <span className="text-muted-foreground">
                      {' · '}
                      {step.found > 0 ? `${step.found} found` : STATUS_LABEL[step.status]}
                    </span>
                  </p>
                  <p className="text-muted-foreground">{step.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-caption text-muted-foreground">
            {/* Which domain the site fetch, pattern inference and both
                providers were pointed at, and where that domain came from —
                the single fact that silently disables half the sources when
                it is missing. */}
            {report.domain
              ? `Domain-gated sources ran against ${report.domain}, resolved from ${report.domainBasis}.`
              : `No employer domain to search: ${report.domainBasis}.`}
          </p>
        </details>
      )}
    </div>
  )
}
