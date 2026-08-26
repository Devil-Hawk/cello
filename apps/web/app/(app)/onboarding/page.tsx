'use client'

import { AUTO_SUBMIT_STATUS } from '@/lib/automation/capabilities'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Check,
  FileText,
  Loader2,
  Rocket,
  Sparkles,
  Upload,
} from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Segmented } from '@/components/ui/segmented'
import { toast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import {
  fetchClientSafePreferences,
  SET_ONBOARDING_PREFERENCES_RPC,
} from '@/lib/preferences/client-safe'
import {
  RESUME_UPLOAD_ACCEPT,
  RESUME_UPLOAD_MAX_LABEL,
  SUPPORTED_FORMATS_SENTENCE,
} from '@/lib/resume/import/formats'
import { cn } from '@/lib/utils'

type Step = 'resume' | 'preferences' | 'launch'

const STEPS: { id: Step; label: string }[] = [
  { id: 'resume', label: 'Resume' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'launch', label: 'Launch' },
]

const THRESHOLDS = [
  { value: '50', label: 'Broad (50+)' },
  { value: '70', label: 'Balanced (70+)' },
  { value: '85', label: 'Strict (85+)' },
] as const

export default function OnboardingPage() {
  const router = useRouter()
  const supabase = createClient()
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [step, setStep] = useState<Step>('resume')
  const [checking, setChecking] = useState(true)
  const [hasResume, setHasResume] = useState(false)
  const [uploading, setUploading] = useState(false)

  const [threshold, setThreshold] = useState<string>('70')
  const [autoSubmit, setAutoSubmit] = useState(false)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    ;(async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      // Split what used to be one `select('resume_text, preferences')`: the
      // resume flag is harmless, but the raw preferences column also carries
      // api_keys ciphertext and autopilot.atsKeys (an ATS board password,
      // never encrypted, per the audit that found this) — read only what
      // this step needs through the safe RPC. See lib/preferences/client-safe.ts.
      const [{ data: profile }, safePrefs] = await Promise.all([
        supabase.from('profiles').select('resume_text').eq('id', user.id).single(),
        fetchClientSafePreferences(supabase as unknown as SupabaseClient),
      ])
      if (profile?.resume_text) {
        setHasResume(true)
      }
      if (typeof safePrefs?.matchThreshold === 'number') setThreshold(String(safePrefs.matchThreshold))
      if (typeof safePrefs?.autoSubmit === 'boolean') setAutoSubmit(safePrefs.autoSubmit)
      setChecking(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function uploadResume(file: File) {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('resume', file)
      const res = await fetch('/api/resume/upload', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setHasResume(true)
      toast({ title: 'Resume uploaded', description: 'We extracted the text for matching.' })
    } catch (e) {
      toast({ title: 'Upload failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    } finally {
      setUploading(false)
    }
  }

  async function savePreferences(): Promise<boolean> {
    setSavingPrefs(true)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return false
      // Used to read the FULL preferences column first (api_keys ciphertext,
      // autopilot.atsKeys included) just to spread it back unchanged around
      // these two fields — the same over-read as the leak above, on the write
      // side. set_onboarding_preferences() does the merge inside Postgres, so
      // the rest of the column never has to travel to the browser in either
      // direction. See the migration and lib/preferences/client-safe.ts.
      const { error } = await (supabase as unknown as SupabaseClient).rpc(
        SET_ONBOARDING_PREFERENCES_RPC,
        { p_match_threshold: Number(threshold) }
      )
      if (error) throw error
      return true
    } catch (e) {
      toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
      return false
    } finally {
      setSavingPrefs(false)
    }
  }

  async function launch() {
    setLaunching(true)
    const ok = await savePreferences()
    if (!ok) {
      setLaunching(false)
      return
    }
    // Kick the first discovery + match run (best-effort — long-running).
    fetch('/api/harness/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Discover fresh open roles from my tracked companies and score them against my resume so I can review the best matches.',
      }),
    }).catch(() => {})
    toast({ title: 'You\'re all set', description: 'Your first discovery run is starting.' })
    router.push('/copilot')
  }

  if (checking) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step)

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
          <Sparkles className="h-5 w-5 text-accent-deep" />
        </div>
        <h1 className="font-display text-title text-foreground">Welcome to Cello</h1>
        <p className="mt-1 text-caption text-muted-foreground">
          Three quick steps and your autonomous job search is live.
        </p>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-caption font-medium',
                i < stepIndex
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : i === stepIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-sunken text-muted-foreground'
              )}
            >
              {i < stepIndex ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span className={cn('text-caption', i === stepIndex ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {s.label}
            </span>
            {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
          </div>
        ))}
      </div>

      <Card className="p-6">
        {step === 'resume' && (
          <div className="space-y-4">
            <div>
              <h2 className="font-display text-section text-foreground">Upload your resume</h2>
              <p className="mt-1 text-caption text-muted-foreground">
                We keep your formatting and extract the text to score job matches and power the ATS
                optimizer. {SUPPORTED_FORMATS_SENTENCE} — up to {RESUME_UPLOAD_MAX_LABEL}.
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={RESUME_UPLOAD_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadResume(f)
              }}
            />
            {hasResume ? (
              <div className="flex items-center gap-2 rounded-control bg-emerald-50 p-3 text-body text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                <FileText className="h-4 w-4" />
                Resume on file — you&apos;re good to go.
                <button
                  type="button"
                  className="ml-auto rounded-sm text-caption underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => fileRef.current?.click()}
                >
                  Replace resume
                </button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading} className="w-full">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? 'Uploading…' : 'Choose file'}
              </Button>
            )}
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => router.push('/dashboard')}>
                Skip for now
              </Button>
              <Button onClick={() => setStep('preferences')} disabled={!hasResume}>
                Next <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {step === 'preferences' && (
          <div className="space-y-5">
            <div>
              <h2 className="font-display text-section text-foreground">Set your preferences</h2>
              <p className="mt-1 text-caption text-muted-foreground">You can change these any time in Settings.</p>
            </div>

            <div>
              <label className="text-label uppercase text-muted-foreground">Match threshold</label>
              <p className="mb-2 text-caption text-muted-foreground">
                Only surface roles scoring at least this well against your resume.
              </p>
              <Segmented
                value={threshold}
                onValueChange={setThreshold}
                options={THRESHOLDS.map((t) => ({ value: t.value, label: t.label }))}
              />
            </div>

            {/* Auto-submit is NOT offered here. It used to be a switch; turning
                it on persisted the preference and the queue page read it back as
                "on", while autopilot always built a pending_review draft instead.
                A user who believes applications are going out stops sending them,
                so a confirmed-but-false setting is worse than none. See
                lib/automation/capabilities.ts. */}
            <div className="rounded-control border p-3">
              <div className="text-body font-medium text-foreground">Applications wait for you</div>
              <p className="mt-1 text-caption text-muted-foreground">{AUTO_SUBMIT_STATUS}</p>
            </div>

            <div className="flex justify-between pt-1">
              <Button variant="ghost" onClick={() => setStep('resume')}>
                Back
              </Button>
              <Button
                onClick={async () => {
                  const ok = await savePreferences()
                  if (ok) setStep('launch')
                }}
                disabled={savingPrefs}
              >
                {savingPrefs ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Next <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {step === 'launch' && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
              <Rocket className="h-5 w-5 text-accent-deep" />
            </div>
            <div>
              <h2 className="font-display text-section text-foreground">Start your first run</h2>
              <p className="mx-auto mt-1 max-w-sm text-caption text-muted-foreground">
                Cello will discover open roles from your companies and match them to your resume. Watch
                it work on the Agent page.
              </p>
            </div>
            <Button onClick={launch} disabled={launching} className="w-full">
              {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {launching ? 'Launching…' : 'Launch Cello'}
            </Button>
            <Button variant="ghost" onClick={() => router.push('/dashboard')} className="w-full">
              Go to dashboard instead
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
