// One chat. PG9 builds it; until then it shows a line to the people who can open it.

import { requireChat } from '../gate'

export const dynamic = 'force-dynamic'

export default async function ChatPage() {
  await requireChat()
  return <p className="p-6 text-muted-foreground">Chat is not open yet.</p>
}
