'use client'

// Renders an assistant turn's markdown exactly as the model wrote it — this
// is the "harness, not a product" renderer: GFM tables become <table>,
// fenced code becomes a highlighted block, links are clickable, lists nest,
// blockquotes and bold/italic render — nothing is re-shaped, and the
// model's own structure IS the answer (see the owner's brief this replaces:
// the old hand-rolled renderer showed literal ``` fences and raw
// [text](url) pairs).
//
// STREAMING-SAFE, CHEAP TO RE-RENDER
// -----------------------------------
// `content` is a plain string that may grow token by token across renders
// (or arrive whole — both are handled identically, there is no separate
// "streaming mode"). Naively handing the *whole* growing string to
// react-markdown on every render would re-parse and re-diff the entire
// message on every token — the exact "reformat again and again" the brief
// objects to.
//
// Instead we split `content` into block-level chunks at blank-line
// boundaries (see render/block-split.ts — it also keeps fenced code and
// loose lists intact across those boundaries) and render each block through
// its own `React.memo`-wrapped <ReactMarkdown>. Blocks are append-only: once
// a block other than the last has appeared, its text never changes again,
// so on the next render it is the same string (JS compares string primitives
// by value) passed to the same memoized component at the same array index —
// React bails out before react-markdown ever re-parses it. Only the last
// ("tail") block, which is genuinely still being written, gets re-parsed
// each render, and it's normally one short paragraph/table/list, not the
// whole message. block-split.test.ts's "append-stable" test asserts this
// property directly (every stable block, once seen, never changes text on a
// later render).
//
// PARTIAL / UNTERMINATED MARKDOWN MID-STREAM
// --------------------------------------------
// We lean on remark/rehype being a real, spec-following CommonMark+GFM
// parser rather than inventing our own "is this safe to render yet?" logic:
//   - An unclosed ``` fence is not an edge case we handle — it is valid
//     CommonMark (an unterminated fence runs to the end of the block) and
//     renders as an open code block automatically.
//   - A table missing its delimiter row (`| --- | --- |`) simply isn't
//     recognised as a table yet; remark-gfm falls back to a plain paragraph
//     of literal text (pipes and all) rather than throwing or emitting
//     malformed markup, then snaps into a real <table> the moment the
//     delimiter row completes. That flip is normal, expected streaming
//     behaviour (the same thing Claude.ai/ChatGPT's own UIs do) — the bar
//     from the brief is "must not crash or produce broken markup", not
//     "must never show an in-progress line", and a real parser degrading to
//     literal text structurally cannot produce broken/malformed DOM the way
//     the old regex renderer's manual ``` handling could.
// rehype-sanitize (GitHub's default schema) strips any raw HTML/script the
// model emits — required because model output is untrusted text — while
// still allowing the GFM output react-markdown itself produces (tables,
// task-list checkboxes, strikethrough).

import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@/lib/utils'
import { splitMarkdownBlocks } from './render/block-split'
import { mdComponents } from './render/elements'

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeSanitize]

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>
      {text}
    </ReactMarkdown>
  )
})
MarkdownBlock.displayName = 'MarkdownBlock'

export interface MarkdownProps {
  /** Raw markdown text, as the model wrote it. May grow across renders. */
  content: string
  className?: string
}

export function Markdown({ content, className }: MarkdownProps) {
  // Recomputing the split is a cheap O(n) string scan (see block-split.ts) —
  // the expensive part this whole module exists to avoid is re-parsing
  // markdown into a React tree, which memoization on MarkdownBlock handles.
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])

  if (blocks.length === 0) return null

  return (
    <div className={cn('copilot-markdown space-y-3', className)}>
      {blocks.map((text, i) => (
        // Index is a stable key here on purpose: blocks are append-only
        // (streaming only ever extends the tail or appends new blocks after
        // it), so a given index always refers to the same logical block
        // across renders — which is what lets MarkdownBlock's memoization
        // bail out for every block except the changing tail.
        <MarkdownBlock key={i} text={text} />
      ))}
    </div>
  )
}
