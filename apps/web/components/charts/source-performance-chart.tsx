'use client'

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTooltip } from './chart-tooltip'
import { CHART_AXIS_COLOR, CHART_GRID_COLOR, SERIES_COLOR } from './tokens'

export interface SourcePerformanceDatum {
  source: string
  total: number
  scored: number
}

export interface SourcePerformanceChartProps {
  data: SourcePerformanceDatum[]
  onRowClick?: (source: string) => void
}

/**
 * Jobs per source, with scored count as a second series — color encodes the
 * SERIES (total intake vs. scored), not the source identity, so this scales
 * to any number of source rows without needing a wide categorical palette.
 * Source identity is the row label (the y-axis), never a color.
 */
export function SourcePerformanceChart({ data, onRowClick }: SourcePerformanceChartProps) {
  const height = Math.max(180, data.length * 34 + 40)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
        barCategoryGap="24%"
        // See ScoreHistogramChart's identical prop for why: recharts 3.x
        // defaults this to true, adding a role="application" + tabIndex={0}
        // stop on the root <svg> that AccessibleFigure's role="img" wrapper
        // (used whenever this chart isn't passed `interactive`) doesn't
        // expect its content to have.
        accessibilityLayer={false}
      >
        <CartesianGrid horizontal={false} stroke={CHART_GRID_COLOR} />
        <XAxis
          type="number"
          allowDecimals={false}
          tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: CHART_GRID_COLOR }}
        />
        <YAxis
          type="category"
          dataKey="source"
          tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={96}
        />
        <Tooltip content={ChartTooltip} cursor={{ fill: 'hsl(var(--foreground) / 0.04)' }} />
        <Legend
          verticalAlign="top"
          height={28}
          wrapperStyle={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}
        />
        <Bar
          dataKey="total"
          name="Total jobs"
          fill={SERIES_COLOR.total}
          radius={[0, 3, 3, 0]}
          onClick={onRowClick ? (entry) => onRowClick((entry as unknown as SourcePerformanceDatum).source) : undefined}
          cursor={onRowClick ? 'pointer' : undefined}
          isAnimationActive={false}
        />
        <Bar
          dataKey="scored"
          name="Scored"
          fill={SERIES_COLOR.scored}
          radius={[0, 3, 3, 0]}
          onClick={onRowClick ? (entry) => onRowClick((entry as unknown as SourcePerformanceDatum).source) : undefined}
          cursor={onRowClick ? 'pointer' : undefined}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
