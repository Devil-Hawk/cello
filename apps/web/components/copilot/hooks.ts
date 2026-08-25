'use client'

// Small client-only hooks shared across the copilot surface.
//
// useIsMobile — viewport-based mobile detection. Drives the rail
// collapse/overlay behavior in conversation-sidebar.tsx and runs-panel.tsx
// (see the "RESPONSIVE" requirement: rails collapse, composer stays
// reachable, nothing overflows horizontally).
//
// useRevealedText — simulates a real typing cadence for text that arrives as
// one complete blob over SSE. Every copilot event (reasoning/thought/final)
// sends its FULL string in a single event — see the wire contract atop
// app/api/copilot/route.ts — there is no token-by-token streaming on the
// wire. Popping the whole string in at once reads as static, not like a
// working agent. This hook reveals a string over a short, LENGTH-BOUNDED
// duration via requestAnimationFrame so a one-line answer still feels snappy
// and a long one never drags out, and is a no-op (full string, no animation)
// whenever `enabled` is false (reconstructed history, settled messages) or
// the user prefers reduced motion.

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@/components/ui/motion'

const MOBILE_QUERY = '(max-width: 767px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(MOBILE_QUERY)
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])
  return isMobile
}

/**
 * Reveal duration for `words` newly-arrived words.
 *
 * Paced per WORD, not per character, and no longer clamped to 900ms. The old
 * cap meant anything past ~330 characters revealed at whatever rate was needed
 * to finish inside 900ms — so a real answer, which is thousands of characters,
 * effectively popped in. That is the opposite of the intent: the reveal exists
 * so an answer reads as being written.
 *
 * ~26ms/word is a fast-but-legible reading cadence (~38 words/sec). The ceiling
 * is generous rather than tight so long answers still finish in a few seconds
 * without ever feeling stuck.
 */
const MS_PER_WORD = 26

function revealDurationMs(words: number): number {
  return Math.min(6000, 90 + words * MS_PER_WORD)
}

/**
 * Index just past the Nth word boundary in `text`, starting the scan at
 * `from`. Advancing on whitespace rather than on characters is what makes the
 * reveal read as words appearing rather than letters accumulating — a
 * character reveal visibly builds each word mid-word, which reads as a
 * teleprinter, not as writing.
 *
 * Whitespace RUNS count as one boundary, so a paragraph break does not consume
 * several words' worth of budget doing nothing visible.
 */
function wordBoundaryAt(text: string, from: number, words: number): number {
  if (words <= 0) return from
  let i = from
  let seen = 0
  while (i < text.length) {
    // Walk to the end of the current word.
    while (i < text.length && !/\s/.test(text[i])) i++
    // Then over the whitespace run that follows it.
    while (i < text.length && /\s/.test(text[i])) i++
    seen++
    if (seen >= words) break
  }
  return i
}

/** How many word boundaries lie between `from` and the end of `text`. */
function countWords(text: string, from: number): number {
  const rest = text.slice(from).trim()
  if (!rest) return 0
  return rest.split(/\s+/).length
}

export interface RevealResult {
  /** The currently-visible prefix of `target`. */
  text: string
  /** True while still animating toward the full string. */
  revealing: boolean
}

/**
 * Animates `text` from its last-shown prefix up to `target` whenever
 * `target` grows, instead of the whole string popping in at once. A `target`
 * that is not an extension of what's currently shown (a different step, a
 * reset) reveals from scratch. Pass `enabled: false` to always show the full
 * string immediately.
 */
export function useRevealedText(target: string, enabled: boolean): RevealResult {
  const prefersReduced = useReducedMotion()
  const skip = !enabled || prefersReduced
  const [revealed, setRevealed] = useState(skip ? target : '')
  const revealedRef = useRef(revealed)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (skip) {
      revealedRef.current = target
      setRevealed(target)
      return
    }
    const from = target.startsWith(revealedRef.current) ? revealedRef.current : ''
    const fromLen = from.length
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (target.length - fromLen <= 0) {
      revealedRef.current = target
      setRevealed(target)
      return
    }
    // Budget in WORDS, so the cadence is the same whether the new text is one
    // long word or several short ones.
    const wordsToReveal = countWords(target, fromLen)
    const duration = revealDurationMs(wordsToReveal)
    let start: number | null = null
    const tick = (ts: number) => {
      if (start === null) start = ts
      const progress = Math.min(1, (ts - start) / duration)
      // Snap to a word boundary. Without this the tail of the visible string is
      // a half-written word on every frame.
      const chars =
        progress >= 1
          ? target.length
          : wordBoundaryAt(target, fromLen, Math.ceil(wordsToReveal * progress))
      const next = target.slice(0, chars)
      revealedRef.current = next
      setRevealed(next)
      rafRef.current = progress < 1 ? requestAnimationFrame(tick) : null
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, skip])

  return { text: revealed, revealing: !skip && revealed !== target }
}
