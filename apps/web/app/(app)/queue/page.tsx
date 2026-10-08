import { redirect } from 'next/navigation'

// The queue moved to Conversations.
export default function QueuePage() {
  redirect('/conversations')
}
