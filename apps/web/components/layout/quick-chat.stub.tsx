// lane-stub: PG9 quick-chat
// Renders nothing until chat pushes components/chat/quick-chat.tsx. The slot
// (quick-chat-slot.tsx) imports this file and switches to the real component
// at integration step 21; this stub is deleted then.

export interface QuickChatStubProps {
  about?: { kind: string; ref: string }
}

export function QuickChat(_props: QuickChatStubProps) {
  return null
}
