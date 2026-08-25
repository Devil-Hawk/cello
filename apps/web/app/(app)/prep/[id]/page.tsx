'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Check, CircleDashed, FileWarning } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { KitView } from '@/components/prep/kit-view'
import { useToast } from '@/components/ui/use-toast'
import type { InterviewKitRow, InterviewQuestion, StarStory, KitStatus } from '@/lib/interview/store'

function relName<T extends { name?: string | null; title?: string | null }>(
  rel: T | T[] | null | undefined
): string {
  const r = Array.isArray(rel) ? rel[0] : rel
  return (r?.title ?? r?.name ?? '').trim()
}

export default function PrepDetailPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [kit, setKit] = useState<InterviewKitRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadKit = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/interview?id=${encodeURIComponent(id)}`)
      const data = await res.json()
      if (res.ok && data.kit) {
        setKit(data.kit as InterviewKitRow)
      } else if (!res.ok) {
        setLoadError("Couldn't load this interview kit. Check your connection and try again.")
      }
      // res.ok but no kit => genuinely doesn't exist; kit stays null, no error.
    } catch {
      setLoadError("Couldn't load this interview kit. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadKit()
  }, [loadKit])

  async function toggleStatus() {
    if (!kit || saving) return
    const next: KitStatus = kit.status === 'practiced' ? 'ready' : 'practiced'
    setSaving(true)
    try {
      const res = await fetch('/api/interview', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: kit.id, status: next }),
      })
      const data = await res.json()
      if (res.ok && data.kit) {
        setKit((prev) => (prev ? { ...prev, status: next } : prev))
      } else {
        toast({ title: 'Could not update', description: data?.error ?? 'Try again.', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Could not update', description: 'Network error.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
        <h1 className="sr-only">Interview kit — loading…</h1>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (loadError) {
    return (
      <EmptyState
        icon={FileWarning}
        title="Couldn't load this interview kit"
        headingLevel="h1"
        body={loadError}
        action={
          <Button onClick={loadKit} size="sm">
            Retry
          </Button>
        }
      />
    )
  }

  if (!kit) {
    return (
      <EmptyState
        icon={CircleDashed}
        title="Kit not found"
        headingLevel="h1"
        body="This interview kit no longer exists."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/prep">Back to prep</Link>
          </Button>
        }
      />
    )
  }

  const title = relName(kit.jobs) || 'Interview kit'
  const company = relName(kit.companies)
  const questions: InterviewQuestion[] = Array.isArray(kit.questions) ? kit.questions : []
  const starStories: StarStory[] = Array.isArray(kit.star_stories) ? kit.star_stories : []

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/prep"
          className="inline-flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All prep kits
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-title text-foreground">{title}</h1>
            <Badge tone={kit.status === 'practiced' ? 'good' : 'neutral'}>
              {kit.status === 'practiced' ? 'Practiced' : 'Ready'}
            </Badge>
          </div>
          {company && <p className="mt-1 text-caption text-muted-foreground">{company}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={toggleStatus} disabled={saving}>
          {kit.status === 'practiced' ? (
            <CircleDashed className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {kit.status === 'practiced' ? 'Mark not practiced' : 'Mark practiced'}
        </Button>
      </div>

      <KitView questions={questions} starStories={starStories} prepNotes={kit.prep_notes ?? ''} />
    </div>
  )
}
