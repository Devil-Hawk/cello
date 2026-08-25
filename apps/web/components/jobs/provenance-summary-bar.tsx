'use client'

// Corpus-wide provenance summary for the Jobs list (docs/PRODUCT-VISION.md #5)
// — a single GET /api/jobs/provenance?summary=1 call so the user can see, at a
// glance across every tracked job, how much of the list is aggregator noise
// masquerading as an employer and how many postings have no description —
// the exact two problems that motivated lib/sources/provenance.ts. A third,
// unrelated fact — how many postings Cello can submit through an official-ATS
// apply flow, per detectApplyTarget() in lib/sources/provenance.ts — rides
// along on its own row below "Source quality" rather than inside it: apply
// capability is a different axis than source quality, not a third quality
// problem. Silent on load failure, and each fact (plus the bar as a whole)
// renders nothing when there's nothing worth flagging, matching this
// codebase's existing convention for passive auto-loaded summaries (see
// components/companies/dossier-panel.tsx's initial fetch).

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Breakdown {
  total: number
  byEmployerClass: Record<string, number>
  descriptionMissing: number
  autoApplySupported: number
}

export function ProvenanceSummaryBar() {
  const [data, setData] = useState<Breakdown | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/jobs/provenance?summary=1')
      .then((r) => r.json().then((json) => ({ ok: r.ok, json })))
      .then(({ ok, json }) => {
        if (cancelled || !ok || !json?.breakdown) return
        setData(json.breakdown as Breakdown)
      })
      .catch(() => {
        /* passive summary — a failed fetch here just means the bar doesn't render */
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!data || data.total === 0) return null

  const aggregatorNoise = data.byEmployerClass.aggregator_as_employer ?? 0
  const descriptionMissing = data.descriptionMissing
  const autoApplySupported = data.autoApplySupported

  // Bail only when none of the three facts have anything to report — not just
  // the first two. Before this fix the apply-capability row rendered
  // unconditionally, so a corpus with zero aggregator noise, zero missing
  // descriptions, and zero apply-capable jobs still produced a bar (reading
  // "0 support automatic application"), which is a bar about nothing.
  if (aggregatorNoise === 0 && descriptionMissing === 0 && autoApplySupported === 0) return null

  const hasQualityFacts = aggregatorNoise > 0 || descriptionMissing > 0
  const hasApplyFact = autoApplySupported > 0

  return (
    <div className="flex flex-col gap-1.5 rounded-card border bg-sunken/50 px-4 py-2.5 text-caption text-muted-foreground">
      {hasQualityFacts && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <AlertTriangle className="h-3.5 w-3.5 text-pipeline-screen" />
            Source quality
          </span>
          {aggregatorNoise > 0 && (
            <span>
              <span className="font-medium text-foreground">{aggregatorNoise}</span> of {data.total} are job boards
              tracked as an employer — open a job to see why
            </span>
          )}
          {descriptionMissing > 0 && (
            <span>
              <span className="font-medium text-foreground">{descriptionMissing}</span> of {data.total} have no
              description on file
            </span>
          )}
        </div>
      )}
      {hasApplyFact && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium text-foreground">Apply capability</span>
          {/* autoApplySupported only means the posting URL matches a supported
              official-ATS flow (lib/sources/provenance.ts's per-job reason:
              "automatic submission is possible"). It does NOT mean these jobs
              get applied to on their own — AUTO_SUBMIT_AVAILABLE is false and
              every draft still waits for a human click
              (lib/automation/capabilities.ts). The copy below has to carry
              that "with your approval" qualifier itself, since unlike the
              per-job panel there's no adjacent reasons list to supply it. */}
          <span>
            <span className="font-medium text-foreground">{autoApplySupported}</span> of {data.total} can be
            submitted through the employer&apos;s official ATS, with your approval
          </span>
        </div>
      )}
    </div>
  )
}
