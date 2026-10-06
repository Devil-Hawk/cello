// The Chat page for a new chat. A question carried in by /ask?ask= lands in the compose box, never sent for the person.

import { ChatView } from '@/components/chat/chat-view'
import { requireChat } from './gate'

export const dynamic = 'force-dynamic'

// "?about=role:<id>" is a thing the person was looking at: it shows as a chip, and attaches when the first turn is sent.
const ABOUT = /^([a-z]+):([\w.:-]{1,200})$/

export default async function ChatPage({ searchParams }: { searchParams: { ask?: string; about?: string } }) {
  const person = await requireChat()
  const about = ABOUT.exec(searchParams.about ?? '')
  return <ChatView chatId={null} person={person} initialAsk={searchParams.ask?.slice(0, 2000)} initialAbout={about ? { kind: about[1], ref: about[2] } : undefined} />
}
