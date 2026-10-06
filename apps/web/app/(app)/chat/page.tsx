// The Chat page for a new chat. A question carried in by /ask?ask= lands in the compose box, never sent for the person.

import { ChatView } from '@/components/chat/chat-view'
import { requireChat } from './gate'

export const dynamic = 'force-dynamic'

export default async function ChatPage({ searchParams }: { searchParams: { ask?: string } }) {
  const person = await requireChat()
  return <ChatView chatId={null} person={person} initialAsk={searchParams.ask?.slice(0, 2000)} />
}
