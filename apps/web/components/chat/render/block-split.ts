// Splits a growing markdown string into block-level chunks so the renderer
// can memoize completed blocks and only re-parse the one that is still
// changing. This is the core of "lightweight streaming" (see markdown.tsx's
// doc comment): as the model's answer grows token by token, every block
// before the last one is byte-for-byte identical to the previous render, so
// React.memo bails out and react-markdown never re-parses it. Only the last
// ("tail") block, which is genuinely still being written, gets re-parsed —
// and it is typically one short paragraph, list, or table, not the whole
// message.
//
// Pure and framework-free on purpose: easy to unit test, easy to reason
// about, no React/markdown-library dependency.

// A fence opens/closes with 3+ backticks or tildes, optionally indented up
// to 3 spaces (CommonMark's fenced-code-block rule).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

// A GFM/CommonMark list marker: "-", "*", "+", or "1.", "1)".
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function looksLikeListItem(line: string): boolean {
  return LIST_ITEM_RE.test(line)
}

/**
 * Split `content` into an ordered list of markdown block strings.
 *
 * Blocks are separated at blank lines, with two deliberate exceptions so a
 * naive split never fragments a construct markdown treats as one unit:
 *
 * 1. **Fenced code blocks** — a blank line inside an open ``` or ~~~ fence
 *    never splits (it's code, not paragraph structure); tracked with a tiny
 *    fence-state machine so an *unclosed* trailing fence (the mid-stream
 *    case) just rides to the end of the last block, which is exactly how
 *    CommonMark itself defines an unterminated fence.
 * 2. **Loose lists** — CommonMark allows blank lines between list items
 *    (`1. a\n\n2. b`) as a single ordered/unordered list. Splitting there
 *    would hand each item to its own react-markdown call, which would each
 *    restart numbering at 1. We only merge across the gap when *both* sides
 *    look like list content, so we don't accidentally glue unrelated
 *    paragraphs together.
 */
export function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []

  const lines = content.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fenceChar: string | null = null
  let fenceLen = 0

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (fenceChar) {
      current.push(line)
      const close = line.match(FENCE_RE)
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      continue
    }

    const open = line.match(FENCE_RE)
    if (open) {
      fenceChar = open[1][0]
      fenceLen = open[1].length
      current.push(line)
      continue
    }

    if (isBlank(line)) {
      // Peek past any further blank lines to the next real content line.
      let j = i + 1
      while (j < lines.length && isBlank(lines[j])) j++
      const next = j < lines.length ? lines[j] : null

      const currentIsList = current.some(looksLikeListItem)
      const nextContinuesList = next !== null && (looksLikeListItem(next) || /^\s{2,}\S/.test(next))

      if (currentIsList && nextContinuesList) {
        current.push(line)
        continue
      }

      flush()
      continue
    }

    current.push(line)
  }

  flush()
  return blocks
}
