import { QuickChat } from '@/components/chat/quick-chat'

// The quick chat, from every page. The shell mounts this once; the record
// mounts it with the role it is about.
export function QuickChatSlot({ about }: { about?: { kind: string; ref: string } }) {
  return <QuickChat about={about} />
}
