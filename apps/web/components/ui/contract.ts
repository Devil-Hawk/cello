// The numbers of components/ui/relief.md, as data a test can hold the CSS to.

/** First screen caps (words and groups), laptop and phone. */
export const COPY_CAPS = {
  laptop: { words: 90, groups: 5 },
  phone: { words: 45, groups: 3 },
} as const

/** The still objects: Today's quiet state, Roles' empty For you, and the resting mark. */
export const STILLS = ['quiet', 'empty', 'mark'] as const
export type StillName = (typeof STILLS)[number]

/** Hex per role, light and dark. app/relief.css must carry the same values. */
export const TOKENS = {
  light: {
    ground: '#ecebe7',
    surface: '#fafaf8',
    raised: '#fefefd',
    ink: '#1a1b1f',
    ink2: '#5a5d65',
    ink3: '#666971',
    copper: '#c2641a',
    copperText: '#a9500f',
    petrol: '#3a8686',
    petrolText: '#2e7373',
    ok: '#2f7a4d',
    stop: '#b4402d',
    mark: '#1a1b1f',
    btnFg: '#ffffff',
  },
  dark: {
    ground: '#17181c',
    surface: '#202126',
    raised: '#292a30',
    ink: '#ecebe7',
    ink2: '#b4b7bf',
    ink3: '#94979f',
    copper: '#e0905a',
    copperText: '#e0905a',
    petrol: '#5fb3b3',
    petrolText: '#5fb3b3',
    ok: '#5cb57e',
    stop: '#e07a66',
    mark: '#0e0f12',
    btnFg: '#17181c',
  },
} as const

export type Appearance = keyof typeof TOKENS

/** Tokens a person reads as text (4.5 to 1), against each surface. */
export const TEXT_TOKENS = ['ink', 'ink2', 'ink3', 'copperText', 'petrolText'] as const
/** Tokens that are a bead, ring, mark or glyph (3 to 1). */
export const GLYPH_TOKENS = ['copper', 'petrol', 'ok', 'stop'] as const
export const SURFACES = ['ground', 'surface', 'raised'] as const

function channel(hex: string, at: number): number {
  const c = parseInt(hex.slice(at, at + 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4)
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b))
  const lo = Math.min(luminance(a), luminance(b))
  return (hi + 0.05) / (lo + 0.05)
}
