'use client'

// The contacts surface as what it actually is: a network, not a table. One
// hand-rolled SVG force layout — no dependency, the whole simulation is a
// few nested loops over a few dozen nodes at most (a personal contacts list,
// not a social graph).
//
// Edges are only ever You->contact and contact->company: this is the entire
// shape lib/contacts/network.ts's ContactNode/analyzeNetwork have data for
// today. That module also models a contact->contact "introduced" edge
// (ContactNode.connections, for 2-hop referral paths) but nothing populates
// it anywhere in apps/web — no column, no API field. Drawing that edge here
// would be inventing a connection the data cannot back up, so it is left out
// until something actually writes `connections`.
import { useMemo, useState } from 'react'
import { calculateConnectionStrength, calculateDaysSinceContact } from '@/lib/contacts/network'
import { cn } from '@/lib/utils'
import type { Contact } from './types'

const WIDTH = 960
const HEIGHT = 560
const TICKS = 200

interface GraphNode {
  id: string
  kind: 'you' | 'company' | 'contact'
  label: string
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  strength?: number
  contact?: Contact
}

interface GraphEdge {
  source: string
  target: string
}

/** Deterministic pseudo-random in [0, 1), seeded by a string id. No
 *  Math.random anywhere in this module — the same contacts always start (and
 *  therefore settle) in the same place. */
function hashUnit(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

function contactStrength(contact: Contact): number {
  const daysSince = contact.last_contact_at
    ? calculateDaysSinceContact(new Date(contact.last_contact_at))
    : undefined
  return calculateConnectionStrength(contact.relationship, daysSince)
}

/** Same three buckets contact-row.tsx uses for its strength bar — one
 *  vocabulary for "how strong is this connection" across the page. */
function strengthFillClass(strength: number): string {
  if (strength >= 0.7) return 'fill-emerald-500'
  if (strength >= 0.4) return 'fill-amber-500'
  return 'fill-muted-foreground/40'
}

function buildGraph(contacts: Contact[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const centerX = WIDTH / 2
  const centerY = HEIGHT / 2
  const nodes: GraphNode[] = [
    { id: 'you', kind: 'you', label: 'You', x: centerX, y: centerY, vx: 0, vy: 0, radius: 28 },
  ]
  const edges: GraphEdge[] = []
  const companyNodeIds = new Map<string, string>()

  for (const contact of contacts) {
    if (contact.company_id && contact.companies && !companyNodeIds.has(contact.company_id)) {
      const id = `company:${contact.company_id}`
      companyNodeIds.set(contact.company_id, id)
      const angle = hashUnit(id) * Math.PI * 2
      nodes.push({
        id,
        kind: 'company',
        label: contact.companies.name,
        x: centerX + Math.cos(angle) * 150,
        y: centerY + Math.sin(angle) * 150,
        vx: 0,
        vy: 0,
        radius: 17,
      })
    }
  }

  for (const contact of contacts) {
    const id = `contact:${contact.id}`
    const angle = hashUnit(id) * Math.PI * 2
    const radius = 220 + hashUnit(`${id}:r`) * 70
    nodes.push({
      id,
      kind: 'contact',
      label: contact.name,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      radius: 8 + contactStrength(contact) * 13,
      strength: contactStrength(contact),
      contact,
    })
    edges.push({ source: 'you', target: id })
    const companyId = contact.company_id ? companyNodeIds.get(contact.company_id) : undefined
    if (companyId) edges.push({ source: id, target: companyId })
  }

  return { nodes, edges }
}

// ponytail: O(nodes^2) repulsion per tick — fine for a personal contact list
// (tens of nodes); switch to a quadtree (Barnes-Hut) if this ever needs to
// lay out thousands of nodes at once.
function simulate(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const laidOut = nodes.map((n) => ({ ...n }))
  const byId = new Map(laidOut.map((n) => [n.id, n]))
  const centerX = WIDTH / 2
  const centerY = HEIGHT / 2

  for (let tick = 0; tick < TICKS; tick++) {
    for (let i = 0; i < laidOut.length; i++) {
      for (let j = i + 1; j < laidOut.length; j++) {
        const a = laidOut[i]
        const b = laidOut[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distSq = dx * dx + dy * dy
        if (distSq < 0.01) {
          // Exact overlap — nudge apart deterministically instead of by
          // divide-by-zero luck.
          dx = hashUnit(a.id + b.id) - 0.5
          dy = hashUnit(b.id + a.id) - 0.5
          distSq = 0.01
        }
        const dist = Math.sqrt(distSq)
        const minDist = a.radius + b.radius + 42
        if (dist < minDist) {
          const force = ((minDist - dist) / dist) * 0.5
          const fx = dx * force
          const fy = dy * force
          a.vx += fx
          a.vy += fy
          b.vx -= fx
          b.vy -= fy
        }
      }
    }

    for (const edge of edges) {
      const a = byId.get(edge.source)
      const b = byId.get(edge.target)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const restLength = a.kind === 'company' || b.kind === 'company' ? 130 : 175
      const force = (dist - restLength) * 0.02
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }

    for (const n of laidOut) {
      if (n.kind === 'you') {
        n.x = centerX
        n.y = centerY
        n.vx = 0
        n.vy = 0
        continue
      }
      n.vx += (centerX - n.x) * 0.002
      n.vy += (centerY - n.y) * 0.002
      n.vx *= 0.85
      n.vy *= 0.85
      n.x = Math.max(n.radius + 8, Math.min(WIDTH - n.radius - 8, n.x + n.vx))
      n.y = Math.max(n.radius + 8, Math.min(HEIGHT - n.radius - 8, n.y + n.vy))
    }
  }

  return laidOut
}

export interface PeopleGraphProps {
  contacts: Contact[]
  /** Opens the same contact detail the list row's edit action opens. */
  onSelectContact: (contact: Contact) => void
}

/** The contacts page's default view: you, the companies you have contacts
 *  at, and the people themselves, laid out as a force-directed graph. */
export function PeopleGraph({ contacts, onSelectContact }: PeopleGraphProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const { nodes, edges } = useMemo(() => {
    const graph = buildGraph(contacts)
    return { nodes: simulate(graph.nodes, graph.edges), edges: graph.edges }
  }, [contacts])

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const neighborIds = useMemo(() => {
    if (!hoveredId) return null
    const set = new Set<string>([hoveredId])
    for (const edge of edges) {
      if (edge.source === hoveredId) set.add(edge.target)
      if (edge.target === hoveredId) set.add(edge.source)
    }
    return set
  }, [hoveredId, edges])

  return (
    <div className="overflow-hidden rounded-card border bg-card">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[32rem] w-full"
        role="img"
        aria-label="Your contact network: you, the people you know, and the companies they work at"
      >
        <g>
          {edges.map((edge) => {
            const a = byId.get(edge.source)
            const b = byId.get(edge.target)
            if (!a || !b) return null
            const dimmed = neighborIds
              ? !(neighborIds.has(edge.source) && neighborIds.has(edge.target))
              : false
            return (
              <line
                key={`${edge.source}->${edge.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="hsl(var(--border))"
                strokeWidth={1.5}
                opacity={dimmed ? 0.15 : 0.7}
              />
            )
          })}
        </g>
        <g>
          {nodes.map((node) => {
            const dimmed = neighborIds ? !neighborIds.has(node.id) : false
            const clickable = node.kind === 'contact' && node.contact
            const maxChars = node.kind === 'you' ? 8 : 14
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                opacity={dimmed ? 0.25 : 1}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={clickable ? () => onSelectContact(node.contact as Contact) : undefined}
                className={clickable ? 'cursor-pointer' : undefined}
                role={clickable ? 'button' : undefined}
                aria-label={clickable ? `Open ${node.label}` : undefined}
              >
                <title>{node.label}</title>
                <circle
                  r={node.radius}
                  className={
                    node.kind === 'you'
                      ? 'fill-accent'
                      : node.kind === 'company'
                        ? 'fill-brand'
                        : strengthFillClass(node.strength ?? 0)
                  }
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                />
                <text
                  y={node.radius + 14}
                  textAnchor="middle"
                  className={cn(
                    'select-none fill-foreground text-[11px] font-medium',
                    node.kind === 'you' && 'text-[12px] font-semibold'
                  )}
                >
                  {truncateLabel(node.label, maxChars)}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="flex flex-wrap items-center gap-4 border-t px-4 py-2.5 text-caption text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" /> You
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-brand" /> Company
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Strong connection
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Moderate
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" /> Weak
        </span>
        <span className="ml-auto">Node size = connection strength · hover to trace a path</span>
      </div>
    </div>
  )
}
