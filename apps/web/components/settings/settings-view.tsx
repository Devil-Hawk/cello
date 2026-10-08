'use client'

// Settings (blueprint 4.12) in its sections: Account, Models, Connections, Spend, Notifications, Your data,
// Appearance, Advanced, and for the owner Demo codes. The heavy cards stay where they were built and load only
// when their part is opened, so the page's first load is the sections and nothing else. Never a model id here:
// model names appear in Models only.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { useTheme } from 'next-themes'
import { createClient } from '@/lib/supabase/client'
import { Key } from '@/components/ui/key'
import { ModelsSection } from '@/components/settings/models-section'
import { FixNamesCard } from '@/components/settings/fix-names-card'
import { DataSection } from '@/components/settings/data-section'
import { PushPrompt } from '@/components/push/push-prompt'
import type { BudgetSummary } from '@/components/dashboard/budget-meter-card'

const ConnectionsTab = dynamic(() => import('@/components/settings/connections-tab').then((m) => m.ConnectionsTab), { ssr: false })
const ApiKeysTab = dynamic(() => import('@/components/settings/api-keys-tab').then((m) => m.ApiKeysTab), { ssr: false })
const ModelTab = dynamic(() => import('@/components/settings/model-tab').then((m) => m.ModelTab), { ssr: false })
const ProviderTab = dynamic(() => import('@/components/settings/provider-tab').then((m) => m.ProviderTab), { ssr: false })
const McpTab = dynamic(() => import('@/components/settings/mcp-tab').then((m) => m.McpTab), { ssr: false })
const TokensTab = dynamic(() => import('@/components/settings/tokens-tab').then((m) => m.TokensTab), { ssr: false })
const SearchTab = dynamic(() => import('@/components/settings/search-tab').then((m) => m.SearchTab), { ssr: false })
const SourcesTab = dynamic(() => import('@/components/settings/sources-tab').then((m) => m.SourcesTab), { ssr: false })
const AccessCodesCard = dynamic(() => import('@/components/settings/access-codes-card').then((m) => m.AccessCodesCard), { ssr: false })
const BudgetMeterCard = dynamic(() => import('@/components/dashboard/budget-meter-card').then((m) => m.BudgetMeterCard), { ssr: false })
const OwnerHealthCard = dynamic(() => import('@/components/dashboard/health-card').then((m) => m.OwnerHealthCard), { ssr: false })
const GmailSyncCard = dynamic(() => import('@/components/dashboard/gmail-sync-card').then((m) => m.GmailSyncCard), { ssr: false })
const ActivityList = dynamic(() => import('@/components/settings/activity-list').then((m) => m.ActivityList), { ssr: false })

type Status = (s: 'success' | 'error', message: string) => void

export const SECTIONS: { id: string; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'models', label: 'Models' },
  { id: 'connections', label: 'Connections' },
  { id: 'spend', label: 'Spend' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'data', label: 'Your data' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'advanced', label: 'Advanced' },
]

/** Old ?tab= links (the Gmail sync card, emails) land on the part that took the tab's place. */
export const TAB_TARGET: Record<string, { section: string; fold?: string }> = {
  connections: { section: 'connections' },
  mcp: { section: 'connections', fold: 'tools' },
  'api-keys': { section: 'models', fold: 'key' },
  model: { section: 'models', fold: 'default' },
  provider: { section: 'models', fold: 'computer' },
  search: { section: 'advanced', fold: 'search' },
  tokens: { section: 'advanced', fold: 'tokens' },
  sources: { section: 'advanced', fold: 'older' },
}

/** A part that loads when it is opened. Native details, so it also works before any script. */
function Fold({ id, title, open, children }: { id: string; title: string; open?: boolean; children: () => ReactNode }) {
  const [shown, setShown] = useState(Boolean(open))
  return (
    <details id={`fold-${id}`} className="r-dg" open={open} onToggle={(e) => e.currentTarget.open && setShown(true)}>
      <summary>
        <span>{title}</span>
        <ChevronDown className="r-dg-chevron h-[18px] w-[18px]" aria-hidden />
      </summary>
      <div className="r-dg-body pb-4">{shown ? children() : null}</div>
    </details>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="r-sheet scroll-mt-6 space-y-4 p-6">
      <h2 id={`${id}-h`} className="r-title">{title}</h2>
      {children}
    </section>
  )
}

function Account({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false)
  async function signOut() {
    setBusy(true)
    await createClient().auth.signOut()
    window.location.assign('/login')
  }
  return (
    <>
      <p className="r-body">{email ? `Signed in as ${email}.` : 'Reading your account.'}</p>
      <div className="flex flex-wrap gap-2">
        <Key asChild variant="raised"><Link href="/profile">Your profile</Link></Key>
        <Key variant="ghost" disabled={busy} onClick={signOut}>Sign out</Key>
      </div>
    </>
  )
}

/** The stored grant and the last read, the same GET the Connections card reads; Sync now lives in the card. */
function GmailStatus() {
  const [g, setG] = useState({ monitor: false, backgroundReady: false, lastSyncAt: null as string | null })
  useEffect(() => {
    fetch('/api/gmail/permissions')
      .then(async (res) => {
        if (!res.ok) return
        const s = await res.json()
        setG({ monitor: s?.permissions?.monitor?.enabled ?? false, backgroundReady: s?.backgroundReady ?? false, lastSyncAt: s?.lastSyncAt ?? null })
      })
      .catch(() => undefined)
  }, [])
  return <GmailSyncCard monitor={g.monitor} backgroundReady={g.backgroundReady} lastSyncAt={g.lastSyncAt} />
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** One line of the spend, as the person reads it. Pure. */
export function spendLines(b: BudgetSummary | null, hasKey: boolean): string[] {
  if (!hasKey) return ['You pay nothing. Cello uses free models and your own computer.']
  if (!b) return []
  const lines = [`${usd(b.spentUsd)} of ${usd(b.monthlyUsd)} used this month.`]
  if (b.heldUsd && b.heldUsd > 0) lines.push(`${usd(b.heldUsd)} held for work in progress.`)
  return lines
}

function Spend({ hasKey, onStatus }: { hasKey: boolean | null; onStatus: Status }) {
  const [budget, setBudget] = useState<BudgetSummary | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/settings/budget')
      .then(async (res) => {
        const b = res.ok ? ((await res.json()) as { budget?: Partial<BudgetSummary> }).budget : null
        if (!live) return
        if (b && typeof b.spentUsd === 'number' && typeof b.monthlyUsd === 'number') setBudget({ spentUsd: b.spentUsd, monthlyUsd: b.monthlyUsd, heldUsd: typeof b.heldUsd === 'number' ? b.heldUsd : 0, periodStart: typeof b.periodStart === 'string' ? b.periodStart : '' })
        else setFailed(true)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])
  if (hasKey === null) return <p className="r-meta">Reading.</p>
  return (
    <>
      {spendLines(budget, hasKey).map((l) => <p key={l} className="r-body">{l}</p>)}
      {hasKey && <BudgetMeterCard budget={budget} loadFailed={failed} onBudgetChange={(monthlyUsd) => { setBudget((b) => (b ? { ...b, monthlyUsd } : b)); onStatus('success', 'Saved.') }} />}
    </>
  )
}

/** Quiet hours are Your search's setting; here is where the person finds them for notifications. */
function Notifications() {
  return (
    <>
      <p className="r-body">Cello tells you about replies, interviews and offers, and sends your daily summary to your own inbox when you turn it on. An offer or an interview comes through quiet hours.</p>
      <p className="r-body">
        The summary, the quiet hours and what Cello prepares each morning are in <Link href="/search#on-its-own" className="underline">Your search</Link>.
      </p>
      <div className="space-y-1">
        <h3 className="r-name">On this device</h3>
        <PushPrompt />
      </div>
    </>
  )
}

const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const

function Appearance() {
  const { theme, setTheme } = useTheme()
  // next-themes knows the choice only after mount
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const current = mounted ? (theme ?? 'system') : null
  return (
    <>
      <p className="r-body">Light, dark or the one your device uses. The key in the bar switches it too.</p>
      <div role="group" aria-label="Appearance" className="flex flex-wrap gap-2">
        {THEMES.map((t) => (
          <Key key={t.id} variant={current === t.id ? 'ink' : 'raised'} aria-pressed={current === t.id} onClick={() => setTheme(t.id)}>{t.label}</Key>
        ))}
      </div>
    </>
  )
}

function A2a() {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <div className="space-y-2">
      <p className="r-body">Other agents can ask Cello for research at <code>{origin}/api/a2a</code> with an access token from Tokens. They can read and research. They cannot send anything or change a setting.</p>
      <p className="r-body">Your own assistant reaches Cello at <code>{origin}/api/mcp</code> with a token too. It can read postings, search your material and save drafts that you approve.</p>
    </div>
  )
}

function Advanced({ onStatus, open }: { onStatus: Status; open?: string }) {
  return (
    <div>
      <Fold id="assistant" title="Use Cello from your assistant (MCP) and other agents (A2A)" open={open === 'assistant'}>{() => <A2a />}</Fold>
      <Fold id="tokens" title="Tokens" open={open === 'tokens'}>{() => <TokensTab onStatus={onStatus} />}</Fold>
      <Fold id="search" title="Web search keys" open={open === 'search'}>{() => <SearchTab onStatus={onStatus} />}</Fold>
      <Fold id="activity" title="Activity" open={open === 'activity'}>{() => <ActivityList />}</Fold>
      <Fold id="names" title="Fix company names" open={open === 'names'}>{() => <FixNamesCard />}</Fold>
      <Fold id="older" title="Older settings" open={open === 'older'}>{() => <SourcesTab onStatus={onStatus} />}</Fold>
    </div>
  )
}

export function SettingsView({ owner }: { owner: boolean }) {
  const params = useSearchParams()
  const target = TAB_TARGET[params.get('tab') ?? '']
  const [email, setEmail] = useState<string | null>(null)
  const [keys, setKeys] = useState<{ openai: boolean; anthropic: boolean; openrouter: boolean; hunter: boolean; apollo: boolean } | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onStatus: Status = (s, text) => {
    setBanner({ ok: s === 'success', text })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setBanner(null), 3000)
  }

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null)).catch(() => undefined)
    fetch('/api/settings/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        setKeys({ openai: Boolean(s?.keys?.openai), anthropic: Boolean(s?.keys?.anthropic), openrouter: Boolean(s?.keys?.openrouter), hunter: Boolean(s?.keys?.hunter), apollo: Boolean(s?.keys?.apollo) })
        setModel(s?.model ?? null)
      })
      .catch(() => setKeys({ openai: false, anthropic: false, openrouter: false, hunter: false, apollo: false }))
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  // an old link opens the part that replaced its tab
  useEffect(() => {
    if (!target) return
    document.getElementById(target.fold ? `fold-${target.fold}` : target.section)?.scrollIntoView?.({ block: 'start' })
  }, [target])

  const ownKey = keys ? keys.openai || keys.anthropic || keys.openrouter : null
  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-8 px-4 py-6 sm:px-6">
      <header>
        <h1 className="r-display">Settings</h1>
      </header>
      <nav aria-label="Settings sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {[...SECTIONS, ...(owner ? [{ id: 'demo-codes', label: 'Demo codes' }] : [])].map((s) => (
          <Key key={s.id} asChild variant="raised"><a href={`#${s.id}`}>{s.label}</a></Key>
        ))}
      </nav>
      {banner && <p className="r-meta" role={banner.ok ? 'status' : 'alert'}>{banner.text}</p>}

      <Section id="account" title="Account"><Account email={email} /></Section>

      <Section id="models" title="Models">
        <ModelsSection>
          <div>
            <Fold id="key" title="Your own key" open={target?.fold === 'key'}>
              {() => <ApiKeysTab initialHasOpenai={Boolean(keys?.openai)} initialHasAnthropic={Boolean(keys?.anthropic)} initialHasOpenrouter={Boolean(keys?.openrouter)} initialHasHunter={Boolean(keys?.hunter)} initialHasApollo={Boolean(keys?.apollo)} onStatus={onStatus} />}
            </Fold>
            <Fold id="default" title="Default model and effort" open={target?.fold === 'default'}>{() => <ModelTab initialModel={model} onStatus={onStatus} />}</Fold>
            <Fold id="computer" title="This computer" open={target?.fold === 'computer'}>{() => <ProviderTab onStatus={onStatus} />}</Fold>
          </div>
        </ModelsSection>
      </Section>

      <Section id="connections" title="Connections">
        <ConnectionsTab onStatus={onStatus} />
        <GmailStatus />
        <Fold id="tools" title="Your own tools" open={target?.fold === 'tools'}>{() => <McpTab onStatus={onStatus} />}</Fold>
      </Section>

      <Section id="spend" title="Spend"><Spend hasKey={ownKey} onStatus={onStatus} /></Section>
      <Section id="notifications" title="Notifications"><Notifications /></Section>
      <Section id="data" title="Your data"><DataSection /></Section>
      <Section id="appearance" title="Appearance"><Appearance /></Section>
      <Section id="advanced" title="Advanced">
        <Advanced onStatus={onStatus} open={target?.section === 'advanced' ? target.fold : undefined} />
      </Section>

      {owner && (
        <Section id="demo-codes" title="Demo codes">
          <p className="r-body">Owner only. Each code with its sign-ins, actions, pages and refused actions.</p>
          <AccessCodesCard />
          <OwnerHealthCard />
          <Key asChild variant="raised"><Link href="/owner/scorecard">Open the scorecard</Link></Key>
        </Section>
      )}
    </div>
  )
}
