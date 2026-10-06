// An old Ask Cello link opens the same chat.

import { redirect } from 'next/navigation'

export default function AskChatPage({ params }: { params: { id: string } }) {
  redirect(`/chat/${encodeURIComponent(params.id)}`)
}
