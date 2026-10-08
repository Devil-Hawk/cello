'use client'

// The network map: you at the centre, employers as tiles, people around their employer, one line per person
// in touch. A line is shorter the more recent the last touch and heavier the more they replied, drawn by code
// from contact_touch with no number on it. d3-force lays it out once per data change (a fixed number of ticks,
// never a running loop) and d3-zoom pans and pinches. A node is a button and opens the person.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { select } from 'd3-selection'
import { zoom } from 'd3-zoom'
import type { PersonRow } from '@/lib/network/people'

interface N extends SimulationNodeDatum {
  id: string
  kind: 'you' | 'employer' | 'person'
  label: string
  href?: string
}
interface L extends SimulationLinkDatum<N> {
  dist: number
  width: number
}

const TICKS = 150
const W = 900
const H = 640
const DAY = 86_400_000

/** The layout, pure: same people give the same positions. Exported for the test. */
export function layout(people: PersonRow[], now = new Date()): { nodes: N[]; links: L[] } {
  const nodes: N[] = [{ id: 'you', kind: 'you', label: 'You' }]
  const links: L[] = []
  const employers = new Map<string, N>()
  for (const p of people) {
    const key = p.employerId ?? (p.agency ? `agency:${p.agency}` : null)
    let hub: N | undefined = key ? employers.get(key) : undefined
    if (key && !hub) {
      hub = { id: key, kind: 'employer', label: p.employer ?? p.agency ?? 'Employer' }
      employers.set(key, hub)
      nodes.push(hub)
      links.push({ source: 'you', target: key, dist: 150, width: 1 })
    }
    const person: N = { id: p.id, kind: 'person', label: p.name, href: `/network/${p.id}` }
    nodes.push(person)
    const days = p.lastAt ? Math.max(0, (now.getTime() - new Date(p.lastAt).getTime()) / DAY) : 365
    links.push({ source: hub ? hub.id : 'you', target: p.id, dist: 28 + Math.min(days, 240) * 0.45, width: 1 + Math.min(p.receivedN, 8) * 0.45 })
  }
  const sim = forceSimulation(nodes)
    .force('link', forceLink<N, L>(links).id((n) => n.id).distance((l) => l.dist).strength(0.9))
    .force('charge', forceManyBody().strength(-70))
    .force('collide', forceCollide(14))
    .force('center', forceCenter(W / 2, H / 2))
    .stop()
  // a fixed number of ticks, once: a map of 300 people costs 150 ticks, not an animation loop
  for (let i = 0; i < TICKS; i++) sim.tick()
  return { nodes, links }
}

export function NetworkMap({ people }: { people: PersonRow[] }) {
  const router = useRouter()
  const svg = useRef<SVGSVGElement>(null)
  const group = useRef<SVGGElement>(null)
  const [full, setFull] = useState(false)
  const { nodes, links } = useMemo(() => layout(people), [people])

  useEffect(() => {
    const el = svg.current
    if (!el || !group.current) return
    const g = select(group.current)
    const z = zoom<SVGSVGElement, unknown>().scaleExtent([0.4, 4]).on('zoom', (e) => g.attr('transform', e.transform.toString()))
    select(el).call(z)
    return () => {
      select(el).on('.zoom', null)
    }
  }, [])

  if (people.length === 0) return <p className="r-body">Nobody to draw yet.</p>
  const at = (n: string | N) => (typeof n === 'string' ? nodes.find((x) => x.id === n)! : n)
  return (
    <div className={full ? 'fixed inset-0 z-50 bg-[var(--r-ground)] p-4' : 'relative'}>
      <button type="button" className="r-key r-key-raised absolute right-3 top-3 z-10 min-h-11 min-w-11 px-3" onClick={() => setFull(!full)} aria-pressed={full}>
        {full ? 'Close map' : 'Full screen'}
      </button>
      <svg ref={svg} role="group" aria-label="Your network map. Drag to move, pinch or scroll to zoom." viewBox={`0 0 ${W} ${H}`} className={`w-full touch-none ${full ? 'h-full' : 'h-[70vh] min-h-[420px]'}`}>
        <g ref={group}>
          {links.map((l, i) => {
            const s = at(l.source as string | N)
            const t = at(l.target as string | N)
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="var(--r-ink-3)" strokeOpacity={0.5} strokeWidth={l.width} />
          })}
          {nodes.map((n) => {
            const open = () => n.href && router.push(n.href)
            const r = n.kind === 'you' ? 18 : n.kind === 'employer' ? 14 : 8
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                role={n.href ? 'button' : 'img'}
                tabIndex={n.href ? 0 : undefined}
                aria-label={n.href ? `Open ${n.label}` : n.label}
                onClick={open}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open()}
                className={n.href ? 'cursor-pointer' : undefined}
              >
                {/* a 44px target around the dot, invisible */}
                <circle r={22} fill="transparent" />
                <circle r={r} fill={n.kind === 'person' ? 'var(--r-surface)' : 'var(--r-ink)'} stroke="var(--r-ink-2)" strokeWidth={1.5} />
                {n.kind !== 'person' && (
                  <text textAnchor="middle" dy="0.35em" fontSize={r} fill="var(--r-ground)" aria-hidden>
                    {n.label.charAt(0).toUpperCase()}
                  </text>
                )}
                <text y={r + 12} textAnchor="middle" fontSize={11} fill="var(--r-ink-2)" aria-hidden>
                  {n.label.length > 18 ? `${n.label.slice(0, 17)}...` : n.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
