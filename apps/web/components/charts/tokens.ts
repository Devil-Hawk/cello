// Chart color tokens — read the CSS custom properties app/globals.css defines
// under "Chart tokens" so every chart in components/charts/** and
// components/insights/** draws from one place. See globals.css for why these
// are fixed hex (reusing the `pipeline` instrument-tone family) rather than a
// second, theme-varying palette.

import { type ScoreBand } from '@/lib/jobs/score-bands'

/** var(--x) — NOT hsl(var(--x)): the chart tokens are plain hex, unlike the
 *  HSL-triple UI tokens (--accent, --border, etc.), because they're fixed
 *  across themes and don't need the HSL-triple + alpha-channel trick those do. */
function cssVar(name: string): string {
  return `var(${name})`
}

export const SCORE_BAND_COLOR: Record<ScoreBand, string> = {
  unscored: cssVar('--chart-score-unscored'),
  weak: cssVar('--chart-score-bad'),
  fair: cssVar('--chart-score-fair'),
  good: cssVar('--chart-score-good'),
  strong: cssVar('--chart-score-strong'),
}

export type TrustTier = 'official' | 'secondhand' | 'unverified'

export const TRUST_TIER_COLOR: Record<TrustTier, string> = {
  official: cssVar('--chart-trust-official'),
  secondhand: cssVar('--chart-trust-secondhand'),
  unverified: cssVar('--chart-trust-unverified'),
}

export const TRUST_TIER_LABEL: Record<TrustTier, string> = {
  official: "Employer's own board",
  secondhand: 'Via aggregator',
  unverified: 'Unverified',
}

export const SERIES_COLOR = {
  total: cssVar('--chart-series-total'),
  scored: cssVar('--chart-series-scored'),
}

export const CHART_GRID_COLOR = cssVar('--chart-grid')
export const CHART_AXIS_COLOR = cssVar('--chart-axis')
