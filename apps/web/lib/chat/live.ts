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

export interface Live {
  words: string
  tools: { label: string; phase: 'start' | 'end' }[]
}

/** The live block after one stream event. Once Stop is pressed the block holds still: a call already in flight may still send words or tools. */
export function nextLive(current: Live | null, event: { type?: string; text?: unknown; label?: unknown; phase?: unknown }, stopping: boolean): Live | null {
  if (stopping) return current
  if (event.type === 'words' && typeof event.text === 'string') return { words: event.text, tools: current?.tools ?? [] }
  if (event.type === 'tool' && typeof event.label === 'string' && (event.phase === 'start' || event.phase === 'end')) {
    const tools = [...(current?.tools ?? [])]
    const index = tools.findIndex((tool) => tool.label === event.label)
    if (index < 0) tools.push({ label: event.label, phase: event.phase })
    else tools[index] = { label: event.label, phase: event.phase }
    return { words: current?.words ?? '', tools }
  }
  return current
}

/** The live block shows while the newest turn is still the person's (or their line is not stored yet), so it and the stored answer are never on the page together. */
export const liveShows = (live: Live | null, newestKind: string | undefined, sentLinePending: boolean): boolean =>
  Boolean(live && (live.words || live.tools.length > 0) && (sentLinePending || newestKind !== 'cello'))
