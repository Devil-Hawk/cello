// The quick chat every page can open. PG9 fills it; until then it shows nothing,
// so the shell can mount it today.

export type QuickChatProps = {
  /** The thing the person is looking at, attached to the chat as its first tile. */
  about?: { kind: string; ref: string }
}

export function QuickChat(_props: QuickChatProps) {
  return null
}
