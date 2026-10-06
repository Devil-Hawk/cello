import { MarkTwin } from './twins'
import type { StillName } from '@/components/ui/contract'

/**
 * A still object for an empty or done state: a pre-rendered webp at 1x and 2x
 * (public/depth, made by `pnpm depth:stills`), never a canvas. The SVG twin
 * holds the same box underneath, so a missing file shows the twin and nothing
 * shifts.
 */
export function Still({ name, size = 96, alt = '' }: { name: StillName; size?: number; alt?: string }) {
  return (
    <span className="relative inline-block flex-none" style={{ width: size, height: size }}>
      <span className="absolute inset-0">
        <MarkTwin size={size} />
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/depth/${name}@1x.webp`}
        srcSet={`/depth/${name}@1x.webp 1x, /depth/${name}@2x.webp 2x`}
        width={size}
        height={size}
        alt={alt}
        className="absolute inset-0"
        decoding="async"
      />
    </span>
  )
}
