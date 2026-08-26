'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, CheckCircle, ChevronRight, Cpu, Database, FileWarning, Key, KeyRound, Network, Plug, Search, Server, Target, Terminal, User } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ProfileTab } from '@/components/settings/profile-tab'
import { ApiKeysTab } from '@/components/settings/api-keys-tab'
import { ModelTab } from '@/components/settings/model-tab'
import { ProviderTab } from '@/components/settings/provider-tab'
import { TargetingTab } from '@/components/settings/targeting-tab'
import { ConnectionsTab } from '@/components/settings/connections-tab'
import { SourcesTab } from '@/components/settings/sources-tab'
import { SearchTab } from '@/components/settings/search-tab'
import { McpTab } from '@/components/settings/mcp-tab'
import { TokensTab } from '@/components/settings/tokens-tab'
import type { ResumeStatus } from '@/components/settings/resume-upload-card'
import { EMPTY_TARGETING, type Targeting } from '@/lib/targeting'

type TabId = 'profile' | 'connections' | 'sources' | 'search' | 'mcp' | 'tokens' | 'api-keys' | 'provider' | 'model' | 'targeting'

const TABS: Array<{ id: TabId; label: string; icon: typeof User }> = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'sources', label: 'Sources', icon: Database },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'mcp', label: 'MCP', icon: Network },
  { id: 'tokens', label: 'Access tokens', icon: Terminal },
  { id: 'api-keys', label: 'API keys', icon: Key },
  { id: 'provider', label: 'Provider', icon: Server },
  { id: 'model', label: 'Model', icon: Cpu },
  { id: 'targeting', label: 'Job targeting', icon: Target },
]

function isTabId(value: string | null): value is TabId {
  return value !== null && TABS.some((t) => t.id === value)
}

export default function SettingsPage() {
  const supabase = createClient()
  // ?tab=connections lets the Gmail sync card deep-link straight to the fix.
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<TabId>(isTabId(requestedTab) ? requestedTab : 'profile')
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Loaded once, handed to tabs as initial values
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>('none')
  const [resumeInfo, setResumeInfo] = useState<string | null>(null)
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false)
  const [hasOpenrouterKey, setHasOpenrouterKey] = useState(false)
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [targeting, setTargeting] = useState<Targeting>(EMPTY_TARGETING)

  // Status banner
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [saveMessage, setSaveMessage] = useState('')
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    loadUserData()
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reportStatus(status: 'success' | 'error', message: string) {
    setSaveStatus(status)
    setSaveMessage(message)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setSaveStatus('idle'), 3000)
  }

  async function loadUserData() {
    setIsLoading(true)
    setLoadError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoadError("Couldn't verify your session. Sign in again and try again.")
        return
      }

      setEmail(user.email || '')
      setFullName(user.user_metadata?.full_name || user.user_metadata?.name || '')

      // Load profile.
      //
      // maybeSingle, NOT single: `single()` raises PGRST116 when zero rows
      // match, so treating any error here as fatal locked every user without a
      // profiles row (trigger never fired, RLS mismatch, pre-trigger account)
      // out of the whole settings page — including the API-keys tab they would
      // need to fix anything. A missing row is a legitimate state this page has
      // always tolerated; only a real query failure is worth blocking on.
      // Matches lib/resume/store.ts and lib/applications/store.ts.
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('full_name, resume_text')
        .eq('id', user.id)
        .maybeSingle()

      if (profileError) {
        setLoadError("Couldn't load your profile. Check your connection and try again.")
        return
      }

      if (profile) {
        if (profile.full_name) setFullName(profile.full_name)
        if (profile.resume_text) {
          setResumeStatus('has_resume')
          const wordCount = profile.resume_text.split(/\s+/).length
          setResumeInfo(`${wordCount} words extracted`)
        }
      }

      // Load account status (key presence, model, resume, targeting) from the
      // single status endpoint — this is the one route that reads
      // profiles.preferences correctly instead of the non-existent
      // profiles.api_keys column.
      try {
        const statusResponse = await fetch('/api/settings/status')
        if (statusResponse.ok) {
          const status = await statusResponse.json()
          setHasOpenaiKey(Boolean(status.keys?.openai))
          setHasAnthropicKey(Boolean(status.keys?.anthropic))
          setHasOpenrouterKey(Boolean(status.keys?.openrouter))
          setCurrentModel(status.model ?? null)
        }
      } catch {
        // Ignore errors loading status
      }

      // Load targeting preferences
      try {
        const targetingResponse = await fetch('/api/settings/targeting')
        if (targetingResponse.ok) {
          const targetingData = await targetingResponse.json()
          if (targetingData.targeting) setTargeting(targetingData.targeting)
        }
      } catch {
        // Ignore errors loading targeting
      }
    } catch {
      // A thrown failure never produces a Supabase `{ error }` object, so
      // checking only that left a hard load failure rendering the tabs with
      // blank/false values — "no resume", "no API keys" — presenting a broken
      // connection as an empty account, which is the worst possible reading on
      // the page where the user comes to check their keys.
      setLoadError("Couldn't load your settings. Check your connection and try again.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-title text-foreground">Settings</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Manage your account and preferences.
        </p>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        {/* Tab nav */}
        {/* Named, because it is no longer only tabs: it now also contains a real
            link out to /settings/access, and an unlabelled landmark next to the
            sidebar's "Primary" one is a coin flip for anyone navigating by
            landmark. */}
        <nav aria-label="Settings sections" className="w-full shrink-0 space-y-1 sm:w-44">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-control px-3 py-2 text-body transition-colors',
                activeTab === tab.id
                  ? 'bg-accent-soft font-medium text-accent-deep'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <tab.icon className="h-4 w-4" aria-hidden />
              {tab.label}
            </button>
          ))}

          {/* Demo access is a ROUTE, not a tab — and until now nothing in the
              app linked to it at all, so the whole feature was unreachable.
              It stays a separate page because it is the one settings surface
              that hands out a credential: it deserves a URL you can bookmark
              mid-demo, a title that names what is happening, and a place for
              the audit trail. Rendered below a rule and with a chevron so it
              reads as "leaves this page" rather than as another tab that swaps
              the panel beside it; the sidebar's Settings sub-item is the other
              way in (components/layout/nav-items.ts). Focus ring comes from
              globals.css's `*:focus-visible`, same as every other nav link. */}
          <div className="mt-2 border-t pt-2">
            <Link
              href="/settings/access"
              className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-body text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
              Demo access
              <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden />
            </Link>
          </div>
        </nav>

        {/* Content */}
        <Card className="min-w-0 flex-1 p-6">
          {saveStatus !== 'idle' && (
            <div
              className={cn(
                'mb-5 flex items-center gap-2 rounded-control p-3 text-body',
                saveStatus === 'success'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
              )}
            >
              {saveStatus === 'success' ? (
                <CheckCircle className="h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0" />
              )}
              {saveMessage}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-5">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : loadError ? (
            <EmptyState
              icon={FileWarning}
              title="Couldn't load your settings"
              body={loadError}
              action={
                <Button size="sm" onClick={loadUserData}>
                  Retry
                </Button>
              }
            />
          ) : activeTab === 'profile' ? (
            <ProfileTab
              initialFullName={fullName}
              email={email}
              initialResumeStatus={resumeStatus}
              initialResumeInfo={resumeInfo}
              onStatus={reportStatus}
            />
          ) : activeTab === 'connections' ? (
            <ConnectionsTab onStatus={reportStatus} />
          ) : activeTab === 'sources' ? (
            <SourcesTab onStatus={reportStatus} />
          ) : activeTab === 'search' ? (
            <SearchTab onStatus={reportStatus} />
          ) : activeTab === 'mcp' ? (
            <McpTab onStatus={reportStatus} />
          ) : activeTab === 'tokens' ? (
            <TokensTab onStatus={reportStatus} />
          ) : activeTab === 'api-keys' ? (
            <ApiKeysTab
              initialHasOpenai={hasOpenaiKey}
              initialHasAnthropic={hasAnthropicKey}
              initialHasOpenrouter={hasOpenrouterKey}
              onStatus={reportStatus}
            />
          ) : activeTab === 'provider' ? (
            <ProviderTab onStatus={reportStatus} />
          ) : activeTab === 'model' ? (
            <ModelTab initialModel={currentModel} onStatus={reportStatus} />
          ) : (
            <TargetingTab initialTargeting={targeting} onStatus={reportStatus} />
          )}
        </Card>
      </div>
    </div>
  )
}
