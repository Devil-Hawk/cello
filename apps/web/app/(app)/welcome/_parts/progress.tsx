import { cn } from '@/lib/utils'
import { SCREENS, SCREEN_TITLES, progress, type Screen } from './logic'

// A strip of pills, one per screen: done ones stand up in ink, the rest lie
// flat. It names the screen and never counts steps.
export function Progress({ screen }: { screen: Screen }) {
  const { index, total } = progress(screen)
  return (
    <div
      role="progressbar"
      aria-label="Progress"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={index}
      aria-valuetext={SCREEN_TITLES[screen]}
      className="flex items-center gap-1.5"
    >
      {SCREENS.map((s, i) => (
        <span key={s} className={cn('h-1 w-9 rounded-full', i < index ? 'r-pill-met' : 'r-pill-missing')} />
      ))}
      <span className="r-meta ml-2">{SCREEN_TITLES[screen]}</span>
    </div>
  )
}
