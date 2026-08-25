'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle, Info, Loader2, Mail, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Panel } from '@/components/ui/panel'
import { AnimatePresence, motion, transitionFast } from '@/components/ui/motion'
import { formatRelativeTime } from '@/lib/utils'

interface GmailSyncResult {
  success?: boolean
  message?: string
  processed?: number
  totalScanned?: number
  createdCompanies?: string[]
  createdApplications?: string[]
  statusUpdates?: Array<{ company: string; status: string; subject: string }>
  updates?: unknown[]
  error?: string
  needsReauth?: boolean
  isFirstSync?: boolean
}

interface GmailSyncCardProps {
  /** Called after a successful sync so the parent can refetch dashboard data. */
  onSynced?: () => void
  /** profiles.preferences.gmail_sync.lastSyncDate — null when never synced. */
  lastSyncedAt?: string | null
}

/**
 * Optional inbox sync — POST /api/gmail/sync. Cello already tracks
 * applications through ATS receipts and browser activity without this; Gmail
 * only adds reply detection on top. Deliberately sized and placed as a
 * secondary utility (see dashboard/page.tsx), not a required setup step, and
 * a missing/expired grant is rendered as a neutral state rather than an
 * error — see the needsReauth branch below.
 */
export function GmailSyncCard({ onSynced, lastSyncedAt = null }: GmailSyncCardProps) {
  const [isSyncing, setIsSyncing] = useState(false)
  const [result, setResult] = useState<GmailSyncResult | null>(null)

  async function syncGmail() {
    setIsSyncing(true)
    setResult(null)

    try {
      const response = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      const data: GmailSyncResult = await response.json()
      setResult(data)

      if (data.success) {
        onSynced?.()
      }
    } catch (error) {
      setResult({
        error:
          error instanceof Error ? error.message : 'Failed to sync Gmail. Please try again.',
      })
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2.5">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <CardTitle className="text-body">Gmail sync</CardTitle>
            <CardDescription>
              {lastSyncedAt
                ? `Last synced ${formatRelativeTime(lastSyncedAt)}.`
                : 'Applications are monitored through ATS receipts and browser activity. Inbox monitoring is off.'}
            </CardDescription>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={syncGmail} disabled={isSyncing}>
          {isSyncing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Syncing…
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              Sync now
            </>
          )}
        </Button>
      </CardHeader>

      <AnimatePresence initial={false}>
        {result && (
          <CardContent>
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transitionFast}
            >
              {result.error ? (
                // Panel, not a nested Card: tint + a single accent edge reads
                // as "a notice inside this surface", not another surface.
                //
                // No Gmail grant is a neutral state, not a failure — this app
                // works fully without one — so needsReauth gets the same
                // muted "sunken" tone as any other informational panel.
                // Real sync errors (unrelated to the connection) keep "bad".
                <Panel
                  tone={result.needsReauth ? 'sunken' : 'bad'}
                  divider="left"
                  className="flex items-start gap-3"
                >
                  <Info
                    className={
                      result.needsReauth
                        ? 'mt-0.5 h-5 w-5 shrink-0 text-muted-foreground'
                        : 'mt-0.5 h-5 w-5 shrink-0 text-pipeline-rejected'
                    }
                  />
                  <div>
                    <p
                      className={
                        result.needsReauth
                          ? 'text-body font-medium text-foreground'
                          : 'text-body font-medium text-red-800 dark:text-red-200'
                      }
                    >
                      {result.needsReauth ? "Gmail isn't connected." : result.error}
                    </p>
                    {result.needsReauth && (
                      <Link
                        href="/settings?tab=connections"
                        className="mt-1 block text-caption text-accent-deep underline"
                      >
                        Connect Gmail in Settings
                      </Link>
                    )}
                  </div>
                </Panel>
              ) : (
                <Panel tone="good" divider="left" className="flex items-start gap-3">
                  <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                  <div className="space-y-3">
                    <p className="text-body font-medium text-emerald-800 dark:text-emerald-200">
                      {result.message}
                    </p>

                    {result.createdCompanies && result.createdCompanies.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-caption font-medium text-emerald-700 dark:text-emerald-300">
                          New companies:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {result.createdCompanies.slice(0, 5).map((company, i) => (
                            <Badge key={i} tone="good">
                              {company}
                            </Badge>
                          ))}
                          {result.createdCompanies.length > 5 && (
                            <Badge tone="good">+{result.createdCompanies.length - 5} more</Badge>
                          )}
                        </div>
                      </div>
                    )}

                    {result.statusUpdates && result.statusUpdates.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-caption font-medium text-emerald-700 dark:text-emerald-300">
                          Status updates:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {result.statusUpdates.map((update, i) => (
                            <Badge key={i} tone="neutral">
                              {update.company}: {update.status}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {!result.createdCompanies?.length &&
                      !result.createdApplications?.length &&
                      !result.statusUpdates?.length && (
                        <p className="text-caption text-pipeline-offer">
                          No new job-related emails found.
                        </p>
                      )}
                  </div>
                </Panel>
              )}
            </motion.div>
          </CardContent>
        )}
      </AnimatePresence>
    </Card>
  )
}
