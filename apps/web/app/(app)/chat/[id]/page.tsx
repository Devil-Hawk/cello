// One chat. Someone else's chat id, or one that does not exist, shows the same plain line.

import { ChatView } from '@/components/chat/chat-view'
import { requireChat } from '../gate'

export const dynamic = 'force-dynamic'

export default async function OneChatPage({ params }: { params: { id: string } }) {
  const person = await requireChat()
  return <ChatView chatId={params.id} person={person} />
}
