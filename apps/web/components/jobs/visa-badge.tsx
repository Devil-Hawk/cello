'use client'

import { ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { VisaSignal } from '@/lib/dossier/store'

const CONFIG: Record<VisaSignal, { tone: 'good' | 'warn' | 'bad'; label: string; Icon: typeof ShieldCheck; title: string }> = {
  likely: {
    tone: 'good',
    label: 'Visa likely',
    Icon: ShieldCheck,
    title: 'Public signals suggest this employer likely sponsors work visas — verify with the employer.',
  },
  unknown: {
    tone: 'warn',
    label: 'Visa unknown',
    Icon: ShieldQuestion,
    title: 'No public sponsorship signal found — verify with the employer.',
  },
  unlikely: {
    tone: 'bad',
    label: 'Visa unlikely',
    Icon: ShieldX,
    title: 'Public signals suggest this employer likely does not sponsor — verify with the employer.',
  },
}

/** Small sponsorship-signal badge. Renders nothing when there is no dossier signal. */
export function VisaBadge({
  signal,
  className,
}: {
  signal: VisaSignal | null | undefined
  className?: string
}) {
  if (!signal) return null
  const cfg = CONFIG[signal]
  if (!cfg) return null
  const { Icon } = cfg
  return (
    <Badge tone={cfg.tone} title={cfg.title} className={className}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </Badge>
  )
}
