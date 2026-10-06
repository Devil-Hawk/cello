'use client'

import { useState } from 'react'
import { Check, HelpCircle, Minus } from 'lucide-react'
import { NOT_FOUND, type FitItem } from '@/lib/fit/types'
import { ReadMark } from '../read-mark'
import { useFit } from './fit-state'
import { SOURCE_LABEL, UNREAD, stripSentence } from './logic'

const WORD = { strength: 'Plus', gap: 'Minus', unknown: 'Not sure' } as const
const ICON = { strength: Check, gap: Minus, unknown: HelpCircle } as const

/** The evidence for one item, in words: the quote and where it was found, what is missing and where code looked, or why nothing is known. */
export function Evidence({ item }: { item: FitItem }) {
  return (
    <div className="space-y-1">
      {item.evidence.map((e) => (
        <p key={`${e.source}${e.ref}`} className="r-body">
          &ldquo;{e.quote}&rdquo; <span className="r-meta">{SOURCE_LABEL[e.source]}</span>
        </p>
      ))}
      {item.verdict === 'gap' && item.evidence.length === 0 && <p className="r-body">Not shown in your resume, answers or material.</p>}
      {item.verdict === 'unknown' && <p className="r-body">{item.notFound ? NOT_FOUND : UNREAD}</p>}
      {item.origin === 'model' && <ReadMark />}
      {item.origin === 'person' && <p className="r-meta">You said{item.note ? `: ${item.note}` : '.'}</p>}
    </div>
  )
}

// The fit strip of the first screen: "5 pluses, 1 minus, 3 not sure", then one pill per requirement,
// each opening its evidence. It counts what is on the page and shows nothing for a posting with no
// requirements. A plus or a minus is never shown without its evidence below the pill.
export function FitStrip() {
  const { items, strip } = useFit()
  const [open, setOpen] = useState<string | null>(null)
  if (items.length === 0) return null
  const shown = items.find((i) => i.requirementId === open)
  return (
    <div className="space-y-3">
      <p className="r-body">{stripSentence(strip)}</p>
      <ul className="flex flex-wrap gap-2" aria-label="Requirements">
        {items.map((i) => {
          const Icon = ICON[i.verdict]
          return (
            <li key={i.requirementId}>
              <button
                type="button"
                aria-expanded={open === i.requirementId}
                aria-label={`${WORD[i.verdict]}: ${i.requirement}`}
                onClick={() => setOpen(open === i.requirementId ? null : i.requirementId)}
                className="r-key r-key-raised inline-flex min-h-11 max-w-full items-center gap-2 font-r"
              >
                <Icon className="h-4 w-4 flex-none" aria-hidden />
                <span className="min-w-0 text-left">{i.requirement.length > 36 ? `${i.requirement.slice(0, 35)}…` : i.requirement}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {shown && (
        <div className="r-sheet space-y-2 p-3" role="region" aria-label="Evidence">
          <p className="r-body">{shown.requirement}</p>
          <p className="r-meta">{WORD[shown.verdict]}</p>
          <Evidence item={shown} />
        </div>
      )}
    </div>
  )
}
