'use client'

import { useEffect, useState } from 'react'
import { BudgetMeterCard, type BudgetSummary } from '@/components/dashboard/budget-meter-card'
import { GmailSyncCard } from '@/components/dashboard/gmail-sync-card'
import { OwnerHealthCard } from '@/components/dashboard/health-card'

interface GmailStatus {
  monitor: boolean
  backgroundReady: boolean
  lastSyncAt: string | null
}

/**
 * The three status cards the old dashboard carried: the monthly AI budget, the
 * owner's health report and the Gmail sync state. Each reads its own route, so
 * a failure in one leaves the others standing.
 */
export function AccountStatus() {
  const [budget, setBudget] = useState<BudgetSummary | null>(null)
  const [budgetFailed, setBudgetFailed] = useState(false)
  const [gmail, setGmail] = useState<GmailStatus>({ monitor: false, backgroundReady: false, lastSyncAt: null })

  useEffect(() => {
    let live = true
    fetch('/api/settings/budget')
      .then(async (res) => {
        const b = res.ok ? ((await res.json()) as { budget?: Partial<BudgetSummary> }).budget : null
        if (!live) return
        if (b && typeof b.spentUsd === 'number' && typeof b.monthlyUsd === 'number') {
          setBudget({
            spentUsd: b.spentUsd,
            monthlyUsd: b.monthlyUsd,
            heldUsd: typeof b.heldUsd === 'number' ? b.heldUsd : 0,
            periodStart: typeof b.periodStart === 'string' ? b.periodStart : '',
          })
        } else setBudgetFailed(true)
      })
      .catch(() => live && setBudgetFailed(true))
    // The STORED grant and token presence, the same GET the Connections tab reads.
    fetch('/api/gmail/permissions')
      .then(async (res) => {
        if (!res.ok || !live) return
        const s = await res.json()
        setGmail({
          monitor: s?.permissions?.monitor?.enabled ?? false,
          backgroundReady: s?.backgroundReady ?? false,
          lastSyncAt: s?.lastSyncAt ?? null,
        })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="space-y-4">
      <BudgetMeterCard
        budget={budget}
        loadFailed={budgetFailed}
        onBudgetChange={(monthlyUsd) => setBudget((b) => (b ? { ...b, monthlyUsd } : b))}
      />
      <OwnerHealthCard />
      <GmailSyncCard monitor={gmail.monitor} backgroundReady={gmail.backgroundReady} lastSyncAt={gmail.lastSyncAt} />
    </div>
  )
}
