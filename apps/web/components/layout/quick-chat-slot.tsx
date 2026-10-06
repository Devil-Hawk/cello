import { QuickChat } from './quick-chat.stub'

// The quick chat, from every page. The shell mounts this once; the record
// mounts it with the role it is about. It renders Chat's component once chat
// has pushed it (integration step 21).
export function QuickChatSlot({ about }: { about?: { kind: string; ref: string } }) {
  return <QuickChat about={about} />
}
