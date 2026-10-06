import { clsx as cn } from 'clsx'

// A bead marks a live state only: copper when the person is needed, ink when
// ready, blocked when a step stopped. Done states carry a check instead.
const TONE = {
  copper: '',
  ink: 'r-bead-ink',
  blocked: 'r-bead-blocked',
} as const

export function Bead({ tone = 'copper', className }: { tone?: keyof typeof TONE; className?: string }) {
  return <span aria-hidden className={cn('r-bead', TONE[tone], className)} />
}
