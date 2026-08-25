'use client'

import { useState } from 'react'
import { CheckCircle, Loader2, Search, Sparkles, Star, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CompanyLogo } from '@/components/companies/company-logo'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'

interface VerificationResult {
  isValid: boolean
  status: string
  message: string
  companyName: string | null
  logoUrl: string | null
  jobCount: number
  confidence: number
  aiVerified: boolean
}

type ResolveSource = 'known' | 'greenhouse' | 'lever' | 'ashby' | 'ai'

interface ResolveCandidate {
  name: string
  domain: string | null
  careerUrl: string | null
  source: ResolveSource
  confidence: 'high' | 'medium' | 'low'
  logoUrl?: string
}

interface ResolveResponse {
  candidates?: ResolveCandidate[]
  error?: string
}

const SOURCE_LABEL: Record<ResolveSource, string> = {
  known: 'Known company',
  greenhouse: 'Greenhouse board found',
  lever: 'Lever board found',
  ashby: 'Ashby board found',
  ai: 'AI suggested · verified',
}

type Mode = 'name' | 'url'

export interface AddCompanyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a company was successfully inserted. */
  onAdded: () => void
}

export function AddCompanyDialog({ open, onOpenChange, onAdded }: AddCompanyDialogProps) {
  const supabase = createClient()

  const [mode, setMode] = useState<Mode>('name')

  // Name-first path.
  const [companyName, setCompanyName] = useState('')
  const [isResolving, setIsResolving] = useState(false)
  const [resolveSearched, setResolveSearched] = useState(false)
  const [candidates, setCandidates] = useState<ResolveCandidate[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  // Career-URL fallback path (unchanged).
  const [careerUrl, setCareerUrl] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)
  const [verification, setVerification] = useState<VerificationResult | null>(null)

  // Shared.
  const [isDreamCompany, setIsDreamCompany] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  function reset() {
    setMode('name')
    setCompanyName('')
    setIsResolving(false)
    setResolveSearched(false)
    setCandidates([])
    setSelectedIndex(null)
    setCareerUrl('')
    setVerification(null)
    setIsDreamCompany(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function resolveCompanyName() {
    const q = companyName.trim()
    if (!q) return
    setIsResolving(true)
    setCandidates([])
    setSelectedIndex(null)
    setResolveSearched(false)

    try {
      const response = await fetch('/api/companies/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: q }),
      })
      const data: ResolveResponse = await response.json()
      setCandidates(Array.isArray(data.candidates) ? data.candidates : [])
    } catch {
      setCandidates([])
    }

    setResolveSearched(true)
    setIsResolving(false)
  }

  async function verifyCareerPage() {
    if (!careerUrl) return
    setIsVerifying(true)
    setVerification(null)

    try {
      const response = await fetch('/api/companies/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: careerUrl }),
      })
      const result = await response.json()
      setVerification(result)
    } catch {
      setVerification({
        isValid: false,
        status: 'error',
        message: 'Failed to verify URL',
        companyName: null,
        logoUrl: null,
        jobCount: 0,
        confidence: 0,
        aiVerified: false,
      })
    }

    setIsVerifying(false)
  }

  /** What would be inserted right now, from whichever path is active — or null if nothing is ready yet. */
  function getReadyCompany(): { name: string; domain: string | null; careerUrl: string | null; logoUrl: string | null } | null {
    if (mode === 'name') {
      const candidate = selectedIndex !== null ? candidates[selectedIndex] : undefined
      if (!candidate) return null
      return {
        name: candidate.name,
        domain: candidate.domain,
        careerUrl: candidate.careerUrl,
        logoUrl: candidate.logoUrl ?? null,
      }
    }
    if (verification?.isValid) {
      let domain: string | null = null
      try {
        domain = new URL(careerUrl).hostname.replace(/^www\./, '')
      } catch {}
      return {
        name: verification.companyName || domain || 'Unknown Company',
        domain,
        careerUrl,
        logoUrl: verification.logoUrl,
      }
    }
    return null
  }

  const ready = getReadyCompany()

  async function addCompany() {
    if (!ready) return

    setIsSaving(true)
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setIsSaving(false)
      return
    }

    const { error } = await supabase.from('companies').insert({
      user_id: user.id,
      name: ready.name,
      domain: ready.domain,
      logo_url: ready.logoUrl,
      // companies.career_url is NOT NULL — '' is the established "no career page
      // yet" sentinel (see getCompanyDomain/isBareHomepage). A tracked company
      // with no board is legitimate; a bare homepage URL is not (that's what
      // fed the garbage HTML-scraper fallback), so we never write one here.
      career_url: ready.careerUrl ?? '',
      is_dream_company: isDreamCompany,
    })

    if (!error) {
      reset()
      onOpenChange(false)
      onAdded()
    }

    setIsSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add company</DialogTitle>
          <DialogDescription>
            {mode === 'name'
              ? 'Type a company name and Cello will find its career page.'
              : 'Enter a career page URL to start tracking jobs.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === 'name' ? (
            <>
              <div>
                <label htmlFor="company-name" className="mb-1.5 block text-caption font-medium text-foreground">
                  Company name
                </label>
                <div className="flex gap-2">
                  <Input
                    id="company-name"
                    type="text"
                    value={companyName}
                    onChange={(e) => {
                      setCompanyName(e.target.value)
                      setCandidates([])
                      setSelectedIndex(null)
                      setResolveSearched(false)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        resolveCompanyName()
                      }
                    }}
                    placeholder="Amazon"
                    className="flex-1"
                    autoFocus
                  />
                  <Button
                    onClick={resolveCompanyName}
                    disabled={!companyName.trim() || isResolving}
                    variant="outline"
                    className="shrink-0"
                  >
                    {isResolving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Search className="h-4 w-4" />
                        Find
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {isResolving && (
                <p className="text-caption text-muted-foreground">
                  Checking Greenhouse, Lever, Ashby, and our known-company directory…
                </p>
              )}

              {!isResolving && resolveSearched && candidates.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-caption font-medium text-foreground">
                    {candidates.length === 1 ? '1 match' : `${candidates.length} matches`} — pick one
                  </p>
                  <div className="divide-y overflow-hidden rounded-card border">
                    {candidates.map((candidate, i) => {
                      const isSelected = selectedIndex === i
                      return (
                        <button
                          key={`${candidate.source}-${candidate.careerUrl ?? candidate.domain ?? i}`}
                          type="button"
                          onClick={() => setSelectedIndex(i)}
                          aria-pressed={isSelected}
                          className={cn(
                            'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                            isSelected ? 'bg-accent-soft' : 'hover:bg-sunken'
                          )}
                        >
                          <CompanyLogo src={candidate.logoUrl ?? null} name={candidate.name} className="h-9 w-9" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-body font-medium text-foreground">
                                {candidate.name}
                              </span>
                              <Badge tone={candidate.source === 'ai' ? 'accent' : 'neutral'}>
                                {candidate.source === 'ai' && <Sparkles className="h-3 w-3" />}
                                {SOURCE_LABEL[candidate.source]}
                              </Badge>
                            </div>
                            <p className="mt-0.5 truncate text-caption text-muted-foreground">
                              {candidate.careerUrl ??
                                (candidate.domain
                                  ? `${candidate.domain} · no verified career page yet`
                                  : 'No verified career page yet — you can still add it')}
                            </p>
                          </div>
                          {isSelected && <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-accent-deep" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {!isResolving && resolveSearched && candidates.length === 0 && (
                <div className="flex items-start gap-3 border-l-2 border-amber-400/60 bg-amber-50/60 py-3 pl-4 dark:bg-amber-500/5">
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-foreground">No matches found</p>
                    <p className="mt-1 text-caption text-muted-foreground">
                      We couldn&apos;t find a career page for &ldquo;{companyName.trim()}&rdquo; automatically. Try
                      the career page URL instead.
                    </p>
                  </div>
                </div>
              )}

              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-caption"
                onClick={() => setMode('url')}
              >
                Enter a career page URL instead
              </Button>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="career-url" className="mb-1.5 block text-caption font-medium text-foreground">
                  Career page URL
                </label>
                <div className="flex gap-2">
                  <Input
                    id="career-url"
                    type="url"
                    value={careerUrl}
                    onChange={(e) => {
                      setCareerUrl(e.target.value)
                      setVerification(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        verifyCareerPage()
                      }
                    }}
                    placeholder="https://company.com/careers"
                    className="flex-1"
                    autoFocus
                  />
                  <Button
                    onClick={verifyCareerPage}
                    disabled={!careerUrl || isVerifying}
                    variant="outline"
                    className="shrink-0"
                  >
                    {isVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
                  </Button>
                </div>
              </div>

              {verification && (
                <div
                  className={cn(
                    'flex items-start gap-3 border-l-2 py-3 pl-4',
                    verification.isValid
                      ? 'border-emerald-400/60 bg-emerald-50/60 dark:bg-emerald-500/5'
                      : 'border-red-400/60 bg-red-50/60 dark:bg-red-500/5'
                  )}
                >
                  {verification.isValid ? (
                    <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-body font-semibold text-foreground">
                        {verification.isValid
                          ? verification.companyName || 'Valid career page'
                          : 'Verification failed'}
                      </p>
                      {verification.aiVerified && (
                        <Badge tone="accent">
                          <Sparkles className="h-3 w-3" />
                          AI verified
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-caption text-muted-foreground">{verification.message}</p>
                  </div>
                  {verification.isValid && verification.logoUrl && (
                    <img
                      src={verification.logoUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded-control border bg-white object-contain p-1"
                    />
                  )}
                </div>
              )}

              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-caption"
                onClick={() => setMode('name')}
              >
                Search by name instead
              </Button>
            </>
          )}

          {ready && (
            <label className="flex cursor-pointer items-center gap-3 rounded-control bg-sunken/60 p-3 transition-colors hover:bg-sunken">
              <input
                type="checkbox"
                checked={isDreamCompany}
                onChange={(e) => setIsDreamCompany(e.target.checked)}
                className="h-4 w-4 rounded border-input text-amber-500 focus:ring-ring"
              />
              <span className="flex items-center gap-2 text-body font-medium text-foreground">
                <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                Mark as dream company
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={addCompany} disabled={!ready || isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            Add company
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
