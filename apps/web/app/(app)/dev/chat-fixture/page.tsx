// /dev/chat-fixture: real renderers on static samples, for screenshots of Chat's markdown, parts and cards without a
// live model turn. Dev and preview only: production answers as if the page does not exist.

import { notFound } from 'next/navigation'
import ChatFixture from './fixture'

export default function ChatFixturePage() {
  if (process.env.VERCEL_ENV === 'production') notFound()
  return <ChatFixture />
}
