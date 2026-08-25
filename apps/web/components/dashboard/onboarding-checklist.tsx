'use client'

import Link from 'next/link'
import { CheckCircle2, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AnimatedList } from '@/components/ui/motion'

interface OnboardingChecklistProps {
  hasCompany: boolean
  hasResume: boolean
  hasApiKey: boolean
}

/** Setup checklist that hides itself once every step is complete. */
export function OnboardingChecklist({ hasCompany, hasResume, hasApiKey }: OnboardingChecklistProps) {
  const items = [
    {
      done: hasCompany,
      label: 'Add your first company',
      body: 'Track companies you care about — their open roles are discovered automatically.',
      href: '/companies',
      cta: 'Add company',
    },
    {
      done: hasResume,
      label: 'Upload your resume',
      body: 'Powers AI match scores for every discovered job.',
      href: '/settings',
      cta: 'Upload',
    },
    {
      done: hasApiKey,
      label: 'Add an AI API key',
      body: 'Enables match scoring, job insights, and outreach drafts.',
      href: '/settings',
      cta: 'Add key',
    },
  ]

  if (items.every((item) => item.done)) return null

  const remaining = items.filter((item) => !item.done).length

  return (
    <Card>
      <CardHeader>
        <CardTitle>Get set up</CardTitle>
        <CardDescription>
          {remaining} step{remaining === 1 ? '' : 's'} left to unlock everything Cello can do.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* AnimatedList: as steps complete elsewhere in the app and this
            checklist refetches, rows animate rather than hard-cutting. */}
        <AnimatedList
          items={items}
          keyExtractor={(item) => item.label}
          className="divide-y"
          itemClassName="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
          renderItem={(item) => (
            <>
              {item.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-muted-foreground/50" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={
                    item.done
                      ? 'text-body font-medium text-muted-foreground line-through'
                      : 'text-body font-medium text-foreground'
                  }
                >
                  {item.label}
                </p>
                {!item.done && (
                  <p className="text-caption text-muted-foreground">{item.body}</p>
                )}
              </div>
              {item.done ? (
                <span className="text-caption text-muted-foreground">Done</span>
              ) : (
                <Button variant="outline" size="sm" asChild>
                  <Link href={item.href}>{item.cta}</Link>
                </Button>
              )}
            </>
          )}
        />
      </CardContent>
    </Card>
  )
}
