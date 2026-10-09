'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LinearMeter } from '@/components/charts/linear-meter'
import { DB_WARN_BYTES } from '@/lib/quality/db-limits'
import type { HealthReport } from '@/lib/quality/health'

const MB = 1024 * 1024
const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`

function ranOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * The owner's health report: the database against its warning line, when the
 * check last ran and each issue with its next step. `report` undefined means
 * the person is not the owner (or it could not be read), so nothing renders;
 * null means no check has run yet.
 */
export function HealthCard({ report }: { report: HealthReport | null | undefined }) {
  if (report === undefined) return null
  return (
    <Card>
      <CardHeader className="space-y-0">
        <CardTitle className="text-body">Health</CardTitle>
        <CardDescription>{report ? `Last ran ${ranOn(report.checked_at)}` : 'Database, schedules and sources'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {report === null ? (
          <p className="text-caption text-muted-foreground">No health check has run yet. It runs once a day.</p>
        ) : (
          <>
            {report.db_bytes === null ? (
              <p className="text-caption text-muted-foreground">The database size cannot be read.</p>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-readout text-readout tabular-nums text-foreground">{mb(report.db_bytes)}</span>
                  <span className="text-caption text-muted-foreground">of {mb(DB_WARN_BYTES)}</span>
                </div>
                <LinearMeter
                  ratio={report.db_bytes / DB_WARN_BYTES}
                  label={`Database size: ${mb(report.db_bytes)} of ${mb(DB_WARN_BYTES)}`}
                />
              </>
            )}
            {report.issues.length === 0 ? (
              <p className="text-caption text-muted-foreground">Nothing needs your attention.</p>
            ) : (
              <ul className="space-y-2">
                {report.issues.map((issue) => (
                  <li key={`${issue.kind}:${issue.subject}`}>
                    <p className="text-caption font-medium text-foreground">{issue.text}</p>
                    <p className="text-caption text-muted-foreground">{issue.next}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Fetches the latest report. A 404 (not the owner) or any failure leaves the card out. */
export function OwnerHealthCard() {
  const [report, setReport] = useState<HealthReport | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    fetch('/api/ops/health')
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as { report?: HealthReport | null }
        if (live) setReport(body.report ?? null)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  return <HealthCard report={report} />
}
