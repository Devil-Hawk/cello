// Resume Markdown -> a small, flat, renderer-friendly block model.
//
// THIS IS THE SINGLE SOURCE OF TRUTH for "what does this resume actually say
// and how is it emphasised". Every exporter (PDF today, anything else later)
// and the ATS plain-text derivation go through this module, so they cannot
// drift apart.
//
// WHY remark AND NOT A HAND-ROLLED PARSER
//   react-markdown@10 — already a dependency, and what the studio editor uses
//   for its live preview — IS unified + remark-parse@11 + remark-gfm@4 under
//   the hood. This module deliberately uses those same three packages. In this
//   pnpm store they resolve to the same physical
//   unified@11.0.5 / remark-parse@11.0.0 / remark-gfm@4.0.1 that
//   react-markdown resolves to, so the preview the user edits against and the
//   document that gets exported are parsed by LITERALLY THE SAME GRAMMAR.
//   That shared grammar is the whole reason "what you see is what exports"
//   holds. A hand-rolled parser here would guarantee the two diverge on the
//   first edge case (nested lists, escapes, `*` inside a word, ...).
//
//   remark-parse and unified were previously present only TRANSITIVELY, via
//   react-markdown. They are now EXPLICIT dependencies of apps/web: a
//   transitive resolution is something pnpm is free to change under us, and
//   this module would break silently the day it did.
//
// WHY A BLOCK MODEL AND NOT mdast DIRECTLY
//   mdast is a general-purpose AST. Renderers should never walk it — every
//   renderer that did would re-implement inline emphasis handling, and they
//   would disagree. The model below is deliberately tiny and FLAT:
//
//     ResumeBlock[]  ->  block.lines: ResumeInlineLine[]  ->  ResumeInlineRun[]
//
//   A renderer lays out one line by iterating its runs and switching font per
//   run. It never re-parses anything, and `**Senior ML Engineer**` arrives as
//   { text: 'Senior ML Engineer', bold: true } — never as literal asterisks.
//
// WHY `lines` AND NOT ONE STRING PER BLOCK
//   Every resume already stored in this product is PLAIN TEXT. Run plain text
//   through a Markdown parser and a contact block like
//     Jane Doe
//     jane@example.com | 555-0100
//   is one paragraph containing a soft line break. If a block carried a single
//   flat string we would reflow that into one run-on line and mangle every
//   existing resume. So a block carries pre-split lines, and hard/soft breaks
//   both become line boundaries. Renderers still word-wrap each line to the
//   column width; they just never JOIN lines the author separated.

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type {
  Definition,
  List as MdastList,
  ListItem as MdastListItem,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast'

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

/**
 * Only 1-3 are modelled. Real resumes use name (h1), section (h2) and
 * role/company (h3); anything deeper is clamped to 3 rather than dropped, so a
 * pasted document with h4+ still renders.
 */
export type ResumeHeadingLevel = 1 | 2 | 3

/**
 * A contiguous span of text sharing one set of inline marks. Marks are flags
 * rather than a nested tree so that bold-italic is one run, not two nodes.
 * Absent flags mean "off" — renderers should read them as `run.bold === true`.
 */
export interface ResumeInlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  /** Inline code (or a fenced code block's contents). Render in the mono font. */
  code?: boolean
  /** Present when this run came from a link. Never rendered as visible text. */
  href?: string
}

/** One authored line. Renderers word-wrap it; they must not join it to the next. */
export type ResumeInlineLine = ResumeInlineRun[]

export interface ResumeHeadingBlock {
  type: 'heading'
  level: ResumeHeadingLevel
  lines: ResumeInlineLine[]
}

export interface ResumeParagraphBlock {
  type: 'paragraph'
  lines: ResumeInlineLine[]
}

/**
 * One bullet. Nested lists are FLATTENED into the parent block's `items` with
 * an increasing `depth`, in document order — a renderer walks a single array
 * and indents by depth instead of recursing.
 */
export interface ResumeListItem {
  /** 0 = top level. */
  depth: number
  /** Whether this item's own list is ordered (a nested list may differ). */
  ordered: boolean
  /** 1-based number within its own list level. Undefined for bullets. */
  marker?: number
  lines: ResumeInlineLine[]
}

export interface ResumeListBlock {
  type: 'list'
  /** Whether the OUTERMOST list is ordered. Per-item truth is `item.ordered`. */
  ordered: boolean
  items: ResumeListItem[]
}

/** A horizontal rule (`---`). Carries no text. */
export interface ResumeRuleBlock {
  type: 'rule'
}

export type ResumeBlock =
  | ResumeHeadingBlock
  | ResumeParagraphBlock
  | ResumeListBlock
  | ResumeRuleBlock

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Built once. `.parse()` freezes the processor, which is what installs
 * remark-gfm's micromark extensions — the same lifecycle react-markdown uses.
 * We only parse; there is no mdast->hast transform to run.
 */
const processor = unified().use(remarkParse).use(remarkGfm)

/** Strip the BOM and normalise CRLF/CR so line splitting is platform-agnostic. */
function normalizeSource(md: string): string {
  return md.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

function sameFormatting(a: ResumeInlineRun, b: ResumeInlineRun): boolean {
  return (
    a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href
  )
}

/** Accumulates runs into lines, merging adjacent runs that share formatting. */
class LineAccumulator {
  private readonly lines: ResumeInlineLine[] = [[]]

  push(run: ResumeInlineRun): void {
    if (!run.text) return
    const current = this.lines[this.lines.length - 1]
    const last = current[current.length - 1]
    if (last && sameFormatting(last, run)) {
      last.text += run.text
      return
    }
    current.push({ ...run })
  }

  /** Push text that may itself contain soft line breaks. */
  pushText(text: string, marks: InlineMarks): void {
    const segments = text.split('\n')
    segments.forEach((segment, index) => {
      if (index > 0) this.breakLine()
      this.push({ text: segment, ...marks })
    })
  }

  breakLine(): void {
    this.lines.push([])
  }

  /**
   * Trim each line's outer whitespace, drop runs that trimmed to nothing, and
   * drop lines that ended up empty. An all-empty result yields [].
   */
  finish(): ResumeInlineLine[] {
    const out: ResumeInlineLine[] = []
    for (const line of this.lines) {
      const runs = line.map((run) => ({ ...run }))
      if (runs.length > 0) runs[0].text = runs[0].text.replace(/^\s+/, '')
      if (runs.length > 0) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '')
      const kept = runs.filter((run) => run.text.length > 0)
      if (kept.length > 0) out.push(kept)
    }
    return out
  }
}

interface InlineMarks {
  bold?: boolean
  italic?: boolean
  code?: boolean
  href?: string
}

/** Collect `[label]: url` definitions so linkReference nodes keep their href. */
function collectDefinitions(root: Root): Map<string, string> {
  const defs = new Map<string, string>()
  const visit = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        const def = node as Definition
        defs.set(def.identifier.toLowerCase(), def.url)
      }
      const children = (node as { children?: RootContent[] }).children
      if (Array.isArray(children)) visit(children)
    }
  }
  visit(root.children)
  return defs
}

function lowerPhrasing(
  nodes: readonly PhrasingContent[],
  marks: InlineMarks,
  acc: LineAccumulator,
  defs: Map<string, string>
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        acc.pushText(node.value, marks)
        break
      case 'strong':
        lowerPhrasing(node.children, { ...marks, bold: true }, acc, defs)
        break
      case 'emphasis':
        lowerPhrasing(node.children, { ...marks, italic: true }, acc, defs)
        break
      case 'inlineCode':
        acc.push({ text: node.value, ...marks, code: true })
        break
      case 'link':
        lowerPhrasing(node.children, { ...marks, href: node.url }, acc, defs)
        break
      case 'linkReference': {
        const href = defs.get(node.identifier.toLowerCase())
        lowerPhrasing(node.children, href ? { ...marks, href } : marks, acc, defs)
        break
      }
      case 'break':
        acc.breakLine()
        break
      case 'delete':
        // GFM strikethrough. The model has no strike mark on purpose: struck
        // text in a resume is either a mistake or meant to be deleted, and an
        // ATS reads it as ordinary text either way. Keep the words, drop the mark.
        lowerPhrasing(node.children, marks, acc, defs)
        break
      case 'image':
        // Single-column, image-free by policy (see templates.ts). Keep the alt
        // text, which is the only part an ATS could ever have read.
        acc.pushText(node.alt ?? '', marks)
        break
      case 'imageReference':
        acc.pushText(node.alt ?? '', marks)
        break
      case 'html':
        // Raw HTML would otherwise leak `<b>` into the PDF and the ATS copy.
        break
      case 'footnoteReference':
        break
      default: {
        const children = (node as { children?: PhrasingContent[] }).children
        if (Array.isArray(children)) lowerPhrasing(children, marks, acc, defs)
        break
      }
    }
  }
}

function linesOf(nodes: readonly PhrasingContent[], defs: Map<string, string>): ResumeInlineLine[] {
  const acc = new LineAccumulator()
  lowerPhrasing(nodes, {}, acc, defs)
  return acc.finish()
}

function codeLines(value: string): ResumeInlineLine[] {
  return value
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .map((line): ResumeInlineLine => [{ text: line, code: true }])
}

function clampHeadingLevel(depth: number): ResumeHeadingLevel {
  if (depth <= 1) return 1
  if (depth === 2) return 2
  return 3
}

/**
 * Lower one mdast list into flat items.
 * Rule: an item emits exactly ONE ResumeListItem whose `lines` are all of its
 * non-list children flattened in order; any nested lists are emitted directly
 * after it at depth + 1. Simple, total, and matches how every real resume is
 * actually written.
 */
function lowerList(
  list: MdastList,
  depth: number,
  defs: Map<string, string>,
  out: ResumeListItem[]
): void {
  const ordered = list.ordered === true
  let counter = typeof list.start === 'number' ? list.start : 1

  for (const child of list.children) {
    if (child.type !== 'listItem') continue
    const item = child as MdastListItem
    const acc = new LineAccumulator()
    const nested: MdastList[] = []
    let first = true

    for (const node of item.children) {
      if (node.type === 'list') {
        nested.push(node)
        continue
      }
      if (!first) acc.breakLine()
      first = false
      if (node.type === 'paragraph' || node.type === 'heading') {
        lowerPhrasing(node.children, {}, acc, defs)
      } else if (node.type === 'code') {
        node.value.split('\n').forEach((line, index) => {
          if (index > 0) acc.breakLine()
          acc.push({ text: line, code: true })
        })
      } else {
        const children = (node as { children?: RootContent[] }).children
        if (Array.isArray(children)) {
          for (const inner of children) {
            if (inner.type === 'paragraph') lowerPhrasing(inner.children, {}, acc, defs)
          }
        }
      }
    }

    const lines = acc.finish()
    const marker = ordered ? counter : undefined
    if (ordered) counter += 1
    // An item with no text of its own (only a nested list) still occupies a
    // level, but emitting an empty bullet looks broken — skip it and let the
    // nested items carry the depth.
    if (lines.length > 0) out.push({ depth, ordered, marker, lines })
    for (const sub of nested) lowerList(sub, depth + 1, defs, out)
  }
}

function lowerBlocks(nodes: readonly RootContent[], defs: Map<string, string>): ResumeBlock[] {
  const out: ResumeBlock[] = []

  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const lines = linesOf(node.children, defs)
        if (lines.length > 0) out.push({ type: 'heading', level: clampHeadingLevel(node.depth), lines })
        break
      }
      case 'paragraph': {
        const lines = linesOf(node.children, defs)
        if (lines.length > 0) out.push({ type: 'paragraph', lines })
        break
      }
      case 'thematicBreak':
        out.push({ type: 'rule' })
        break
      case 'list': {
        const items: ResumeListItem[] = []
        lowerList(node, 0, defs, items)
        if (items.length > 0) out.push({ type: 'list', ordered: node.ordered === true, items })
        break
      }
      case 'code': {
        // Almost always an accident: a plain-text resume indented by 4+ spaces
        // parses as an indented code block. Keep the text, mark it mono, and
        // let the template decide how mono looks.
        const lines = codeLines(node.value)
        if (lines.length > 0) out.push({ type: 'paragraph', lines })
        break
      }
      case 'blockquote':
        out.push(...lowerBlocks(node.children, defs))
        break
      case 'table': {
        // GFM tables are lowered to one paragraph PER ROW, cells joined by an
        // em dash. This is not a limitation to fix later: a table in the output
        // PDF is the single most reliable way to get a resume mis-parsed by an
        // ATS (see templates.ts). We keep the words and throw away the grid.
        for (const row of node.children) {
          const acc = new LineAccumulator()
          row.children.forEach((cell, index) => {
            if (index > 0) acc.push({ text: ' — ' })
            lowerPhrasing(cell.children, {}, acc, defs)
          })
          const lines = acc.finish()
          if (lines.length > 0) out.push({ type: 'paragraph', lines })
        }
        break
      }
      case 'html':
      case 'definition':
        break
      case 'footnoteDefinition':
        out.push(...lowerBlocks(node.children, defs))
        break
      default: {
        const children = (node as { children?: RootContent[] }).children
        if (Array.isArray(children)) out.push(...lowerBlocks(children, defs))
        break
      }
    }
  }

  return out
}

/**
 * Parse resume Markdown into the block model. Total: any string in, a (possibly
 * empty) array out. Never throws for empty, whitespace-only or non-Markdown
 * input — every resume already stored in this product is plain text, and plain
 * text is valid Markdown that lowers to paragraphs with their line structure
 * intact.
 */
export function parseResumeMarkdown(markdown: string | null | undefined): ResumeBlock[] {
  if (typeof markdown !== 'string') return []
  const source = normalizeSource(markdown)
  if (source.trim().length === 0) return []
  const root = processor.parse(source) as Root
  return lowerBlocks(root.children, collectDefinitions(root))
}

// ---------------------------------------------------------------------------
// ATS plain text
// ---------------------------------------------------------------------------

/**
 * Bullet prefix for unordered items in the plain-text rendering.
 * ASCII hyphen on purpose: it is decodable in every encoding an applicant
 * tracking system might read the file in, and it cannot be mistaken for an
 * emphasis marker the way `*` can. The PDF renderer uses the template's own
 * glyph (see BulletStyle.glyphs) — this constant is the TEXT rendering only.
 */
const PLAIN_BULLET = '- '

/** Two spaces per nesting level: visible to a human, ignorable by a parser. */
const PLAIN_INDENT = '  '

function runsToText(line: ResumeInlineLine): string {
  // Concatenating run.text is what makes this leak-proof: emphasis, code spans
  // and links exist as FLAGS on the run, so there is no syntax left to escape.
  // A link contributes its label only (see markdownToPlainText's doc comment).
  return line.map((run) => run.text).join('')
}

/**
 * Render resume Markdown to the ATS-safe plain text stored in
 * `resume_documents.content`.
 *
 * Derived from the SAME block model the PDF renders, so the two can never
 * describe different resumes.
 *
 * Choices, all of them made for a dumb parser rather than a human reader:
 *   - Emphasis / strong / inline code / strikethrough: markers are DROPPED and
 *     only the words survive. A stray `**` reaching a resume parser is a
 *     real-world failure, not a cosmetic one.
 *   - Headings: emitted as a bare line, with a blank line before them. No `#`,
 *     no underline of `=`/`-` (a line of dashes is a common trigger for a
 *     parser to guess "table").
 *   - Unordered bullets: `- ` prefix, two spaces of indent per nesting level.
 *     Ordered: `1. ` using the source's own numbering.
 *   - Links: the LABEL only. `[Portfolio](https://x.dev)` becomes `Portfolio`.
 *     If you want the URL in the copy an ATS reads, write it as the label —
 *     `[jane.dev](https://jane.dev)` — or paste it bare; GFM autolinks already
 *     have label === url and therefore survive intact.
 *   - Horizontal rules: become a blank line. Drawing `-----` would risk the
 *     same "is this a table?" misread.
 *   - Blocks are separated by exactly one blank line; runs of 3+ newlines are
 *     collapsed and the result is trimmed.
 */
export function markdownToPlainText(markdown: string | null | undefined): string {
  return blocksToPlainText(parseResumeMarkdown(markdown))
}

/**
 * The block-model half of markdownToPlainText, exposed for callers that
 * already hold blocks (e.g. an exporter rendering both formats in one pass).
 */
export function blocksToPlainText(blocks: readonly ResumeBlock[]): string {
  const chunks: Array<{ type: ResumeBlock['type']; text: string }> = []

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        chunks.push({ type: block.type, text: block.lines.map(runsToText).join('\n') })
        break
      case 'list': {
        const lines: string[] = []
        for (const item of block.items) {
          const indent = PLAIN_INDENT.repeat(Math.max(0, item.depth))
          const prefix = item.ordered ? `${item.marker ?? 1}. ` : PLAIN_BULLET
          const continuation = indent + ' '.repeat(prefix.length)
          item.lines.forEach((line, index) => {
            lines.push(index === 0 ? indent + prefix + runsToText(line) : continuation + runsToText(line))
          })
        }
        chunks.push({ type: 'list', text: lines.join('\n') })
        break
      }
      case 'rule':
        chunks.push({ type: 'rule', text: '' })
        break
    }
  }

  let out = ''
  chunks.forEach((chunk, index) => {
    if (index > 0) {
      // Bullets belong to the line above them: "Acme Corp — Senior Engineer"
      // followed by its achievements is ONE unit, and inserting a blank line
      // between them both looks wrong and stops a plain-text resume from
      // round-tripping byte-for-byte. Everything else gets a blank line.
      const glued = chunk.type === 'list' && chunks[index - 1].type === 'paragraph'
      out += glued ? '\n' : '\n\n'
    }
    out += chunk.text
  })

  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convenience for the ingest path: true when `content` looks like it already
 * carries Markdown formatting. Used to decide whether an uploaded document's
 * text can be adopted as `content_json.markdown` verbatim, or whether it is
 * undesigned plain text that the user will style with a template instead.
 */
export function looksLikeMarkdown(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.trim().length === 0) return false
  return /^#{1,6}\s+\S/m.test(text) || /\*\*\S/.test(text) || /^\s*[-*+]\s+\S/m.test(text)
}
