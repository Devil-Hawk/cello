'use client'

// KitView — renders an interview kit: questions grouped by category (accordion),
// STAR story cards tagged with the question they map to, and prep notes.

import { useState } from 'react'
import { ChevronDown, Lightbulb, MessageSquare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { StaggerGroup, StaggerItem } from '@/components/ui/motion'
import { cn } from '@/lib/utils'
import type { InterviewQuestion, StarStory } from '@/lib/interview/store'

const CATEGORY_ORDER = [
  'behavioral',
  'technical',
  'role-specific',
  'company-specific',
  'reverse',
]

const CATEGORY_LABEL: Record<string, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  'role-specific': 'Role-specific',
  'company-specific': 'Company-specific',
  reverse: 'Questions to ask them',
}

function categoryRank(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat)
  return i === -1 ? CATEGORY_ORDER.length : i
}

function QuestionItem({ q }: { q: InterviewQuestion }) {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(q.guidance || q.sampleAnswer)
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-start justify-between gap-3 px-5 py-3 text-left transition-colors',
          hasDetail && 'hover:bg-sunken/60'
        )}
        aria-expanded={open}
      >
        <span className="text-body text-foreground">{q.question}</span>
        {hasDetail && (
          <ChevronDown
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
          />
        )}
      </button>
      {open && hasDetail && (
        <div className="space-y-3 px-5 pb-4">
          {q.guidance && (
            <div>
              <div className="text-label uppercase text-muted-foreground">How to approach it</div>
              <p className="mt-1 text-caption text-muted-foreground">{q.guidance}</p>
            </div>
          )}
          {q.sampleAnswer && (
            <div className="border-l-2 border-accent/30 pl-3">
              <div className="text-label uppercase text-muted-foreground">Sample answer</div>
              <p className="mt-1 whitespace-pre-wrap text-caption text-foreground">{q.sampleAnswer}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function KitView({
  questions,
  starStories,
  prepNotes,
}: {
  questions: InterviewQuestion[]
  starStories: StarStory[]
  prepNotes: string
}) {
  const grouped = new Map<string, InterviewQuestion[]>()
  for (const q of questions) {
    const cat = q.category || 'behavioral'
    const list = grouped.get(cat) ?? []
    list.push(q)
    grouped.set(cat, list)
  }
  const categories = Array.from(grouped.keys()).sort((a, b) => categoryRank(a) - categoryRank(b))

  return (
    <div className="space-y-6">
      {prepNotes && (
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Lightbulb className="h-4 w-4 text-accent-deep" />
            <CardTitle>Prep notes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {prepNotes.split('\n').map((line, i) => {
                const t = line.trim()
                if (!t) return null
                const bullet = /^[-*•]\s*/.test(t)
                return (
                  <p key={i} className={cn('text-body text-muted-foreground', bullet && 'pl-4 -indent-4')}>
                    {bullet ? `• ${t.replace(/^[-*•]\s*/, '')}` : t}
                  </p>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {categories.length > 0 && (
        <Card className="overflow-hidden p-0">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Interview questions</CardTitle>
            <Badge tone="neutral">{questions.length}</Badge>
          </CardHeader>
          <Separator />
          <StaggerGroup>
            {categories.map((cat, i) => {
              const list = grouped.get(cat) ?? []
              return (
                <StaggerItem key={cat}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center justify-between bg-sunken/30 px-5 py-2.5">
                    <h3 className="text-label uppercase tracking-wide text-muted-foreground">
                      {CATEGORY_LABEL[cat] ?? cat}
                    </h3>
                    <Badge tone="neutral">{list.length}</Badge>
                  </div>
                  <div>
                    {list.map((q, qi) => (
                      <QuestionItem key={qi} q={q} />
                    ))}
                  </div>
                </StaggerItem>
              )
            })}
          </StaggerGroup>
        </Card>
      )}

      {starStories.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <MessageSquare className="h-4 w-4 text-accent-deep" />
            <CardTitle>STAR stories</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <p className="pb-4 text-caption text-muted-foreground">
              Drawn from your resume — verify every detail is accurate before your interview.
            </p>
            {starStories.map((s, i) => (
              <div key={i} className="border-l-2 border-accent/30 py-4 pl-4 first:pt-0 last:pb-0">
                {s.mapsToQuestion && (
                  <Badge tone="accent" className="mb-3">
                    {s.mapsToQuestion}
                  </Badge>
                )}
                <dl className="space-y-2">
                  {(
                    [
                      ['Situation', s.situation],
                      ['Task', s.task],
                      ['Action', s.action],
                      ['Result', s.result],
                    ] as const
                  ).map(([label, value]) =>
                    value ? (
                      <div key={label} className="grid grid-cols-[84px_1fr] gap-2">
                        <dt className="text-label uppercase text-muted-foreground">{label}</dt>
                        <dd className="text-caption text-foreground">{value}</dd>
                      </div>
                    ) : null
                  )}
                </dl>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
