// /agent has been folded into /copilot's right-hand runs panel — this route
// stays so old bookmarks/links still resolve, it just forwards on.

import { redirect } from 'next/navigation'

export default function AgentPage() {
  redirect('/copilot')
}
