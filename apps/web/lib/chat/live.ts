import { parsePartialJson } from '@langchain/core/output_parsers'

function readable(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('')
}

function partsText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { parts?: unknown }).parts)) return null
  const parts = (value as { parts: unknown[] }).parts
  const text = parts
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
  return text || null
}

function partialObject(raw: string): unknown {
  if (!raw.trim().startsWith('{')) return null
  try {
    return parsePartialJson(raw)
  } catch {
    return null
  }
}

/** A link to one of Cello's own things reads as its words while the answer is still being written (the check makes the real link). */
const plainLinks = (text: string): string => text.replace(/\[([^\]]*)\]\(cello:[^)]*\)/g, '$1').replace(/\]?\(?cello:[^\s)]*$/, '')

/** The readable text in an in-flight model message, without exposing tool arguments. */
export const liveText = (message: unknown): string => plainLinks(rawLiveText(message))

function rawLiveText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const value = message as { content?: unknown; tool_calls?: { args?: unknown }[] }
  const content = readable(value.content)
  const parsedContent = typeof value.content === 'string' ? partsText(partialObject(value.content)) : null
  if (parsedContent) return parsedContent
  if (content) return content
  const args = value.tool_calls?.[0]?.args
  if (typeof args === 'string') return partsText(partialObject(args)) ?? ''
  return partsText(args) ?? ''
}

/** Earlier words and the current message's, one blank line apart; an empty side adds nothing. */
export const joinWords = (settled: string, current: string): string => (settled && current ? `${settled}\n\n${current}` : settled || current)
