import { SCROLL_PATH } from '@/components/brand/scroll-path'
import { clsx as cn } from 'clsx'

// The SVG twin of the rendered mark: the same silhouette in the same box, so a
// page with no WebGL (no context, software rendering, Save-Data, a lost
// context, reduced motion) looks the same size and never shifts.
export function MarkTwin({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={cn('r-mark-svg block', className)}
      aria-hidden
      focusable="false"
    >
      <rect width="64" height="64" rx="15" fill="var(--r-mark)" />
      <g transform="translate(32 32) scale(.78) translate(-32 -32)">
        <path
          fill="none"
          stroke="var(--r-mark-stroke)"
          strokeWidth={7}
          strokeLinecap="round"
          d={SCROLL_PATH}
        />
      </g>
    </svg>
  )
}
