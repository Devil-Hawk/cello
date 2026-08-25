'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { FileWarning, GraduationCap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatShortDate } from '@/lib/format'
import type { InterviewKitRow } from '@/lib/interview/store'

function relName<T extends { name?: string | null; title?: string | null }>(
  rel: T | T[] | null | undefined
): string {
  const r = Array.isArray(rel) ? rel[0] : rel
  return (r?.title ?? r?.name ?? '').trim()
}

export default function PrepPage() {
  const [loading, setLoading] = useState(true)
  const [kits, setKits] = useState<InterviewKitRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadKits = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/interview')
      const data = await res.json()
      if (Array.isArray(data.kits)) {
        setKits(data.kits as InterviewKitRow[])
      } else {
        setLoadError("Couldn't load your prep kits. Check your connection and try again.")
      }
    } catch {
      setLoadError("Couldn't load your prep kits. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadKits()
  }, [loadKits])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-title text-foreground">Interview prep</h1>
        <p className="mt-1 text-caption text-muted-foreground">
          Per-job question banks and STAR stories drawn from your real resume.
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          icon={FileWarning}
          title="Couldn't load your prep kits"
          body={loadError}
          action={<Button onClick={loadKits}>Retry</Button>}
        />
      ) : kits.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="No prep kits yet"
          body="Open a job or an application in the screen/interview stage and hit “Prep for interview” to generate a tailored kit."
          action={
            <Button asChild variant="outline">
              <Link href="/jobs">Browse jobs</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {kits.map((kit) => {
            const title = relName(kit.jobs) || 'Interview kit'
            const company = relName(kit.companies)
            const questionCount = Array.isArray(kit.questions) ? kit.questions.length : 0
            const starCount = Array.isArray(kit.star_stories) ? kit.star_stories.length : 0
            return (
              <Link key={kit.id} href={`/prep/${kit.id}`} className="block">
                <Card className="transition-colors hover:bg-sunken/50">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-section text-foreground">{title}</span>
                        <Badge tone={kit.status === 'practiced' ? 'good' : 'neutral'}>
                          {kit.status === 'practiced' ? 'Practiced' : 'Ready'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-caption text-muted-foreground">
                        {company ? `${company} · ` : ''}
                        {questionCount} question{questionCount === 1 ? '' : 's'}
                        {starCount > 0 ? ` · ${starCount} STAR ${starCount === 1 ? 'story' : 'stories'}` : ''}
                      </p>
                    </div>
                    <span className="text-caption text-muted-foreground">
                      {formatShortDate(kit.created_at)}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
