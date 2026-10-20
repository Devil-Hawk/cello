// What the live block of a streaming turn holds and shows. Kept apart from live.ts so the page does not pull in its JSON parser.

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
