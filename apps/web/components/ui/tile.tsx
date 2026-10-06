import * as React from 'react'
import { clsx as cn } from 'clsx'

// The bevel dose follows the size, because a 1px bevel that is right at 40px
// disappears at 64px on a 1x screen: lg from 48, xl from 56.
export function tileDose(size: number): { lg: boolean; xl: boolean } {
  return { lg: size >= 48, xl: size >= 56 }
}

export interface TileProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 28 to 96 px. */
  size?: number
  /** A square mark that fills the tile; the tile carries the brand colour. */
  fill?: boolean
  /** A glyph that needs a dark tile (white mark on navy). */
  dark?: boolean
  /** The copper ring: only the logo on the one lead surface. */
  ring?: boolean
  /** Finished things lie flat and desaturated. */
  flat?: boolean
  /** The tile at the head of a lifted sheet takes the ambient layer. */
  lift?: boolean
  /** The "+3" tile that ends a stack, or an initial for a missing logo. */
  kind?: 'logo' | 'initial' | 'more'
  /** Brand colour behind a filling mark. */
  background?: string
  /** Glyph size as a percentage of the tile. */
  glyph?: number
}

/** App icon container. Children are the logo image or the initial. */
export function Tile({
  size = 48,
  fill,
  dark,
  ring,
  flat,
  lift,
  kind = 'logo',
  background,
  glyph,
  className,
  style,
  children,
  ...props
}: TileProps) {
  const { lg, xl } = tileDose(size)
  const css = {
    width: size,
    height: size,
    borderRadius: `${size * 0.235}px`,
    fontSize: kind === 'more' ? size * 0.34 : size * 0.42,
    ...(background && !dark ? { background } : null),
    ...(glyph ? { ['--g' as string]: `${glyph}%` } : null),
    ...style,
  } as React.CSSProperties
  return (
    <span
      className={cn(
        'r-tile',
        lg && 'r-tile-lg',
        xl && 'r-tile-xl',
        fill && 'r-tile-fill',
        dark && 'r-tile-dark',
        ring && 'r-tile-ring',
        flat && 'r-tile-flat',
        lift && 'r-tile-lift',
        kind === 'initial' && 'r-tile-init',
        kind === 'more' && 'r-tile-more',
        className,
      )}
      style={css}
      {...props}
    >
      {children}
    </span>
  )
}
