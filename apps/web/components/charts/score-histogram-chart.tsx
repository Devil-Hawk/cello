'use client'

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTooltip } from './chart-tooltip'
import { CHART_AXIS_COLOR, CHART_GRID_COLOR } from './tokens'

export interface ScoreHistogramDatum {
  key: string
  label: string
  count: number
  color: string
}

export interface ScoreHistogramChartProps {
  data: ScoreHistogramDatum[]
  activeKey: string | null
  onBarClick: (key: string) => void
}

/**
 * Match-score distribution — a bar per band, colored with the same
 * good/warn/muted/bad status language as the job-card badges (tokens.ts
 * SCORE_BAND_COLOR). Bars are real buttons: click one to drill into the jobs
 * behind it (wired by the caller, components/insights/score-histogram-card.tsx).
 */
export function ScoreHistogramChart({ data, activeKey, onBarClick }: ScoreHistogramChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        barCategoryGap="20%"
        // recharts defaults this to true, which puts role="application" +
        // tabIndex={0} on the chart's root <svg> — an extra, ambiguously-
        // scoped keyboard stop. The bars here are already real, individually
        // focusable buttons (see ScoreHistogramCard), so the whole-chart
        // "application" region adds nothing and only confuses screen-reader
        // users about where the real interactive content is.
        accessibilityLayer={false}
      >
        <CartesianGrid vertical={false} stroke={CHART_GRID_COLOR} />
        <XAxis
          dataKey="label"
          tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: CHART_GRID_COLOR }}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
        />
        <Tooltip content={ChartTooltip} cursor={{ fill: 'hsl(var(--foreground) / 0.04)' }} />
        <Bar
          dataKey="count"
          name="Jobs"
          radius={[4, 4, 0, 0]}
          onClick={(entry) => onBarClick((entry as unknown as ScoreHistogramDatum).key)}
          cursor="pointer"
          isAnimationActive={false}
        >
          {data.map((d) => (
            <Cell
              key={d.key}
              fill={d.color}
              opacity={activeKey && activeKey !== d.key ? 0.45 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
