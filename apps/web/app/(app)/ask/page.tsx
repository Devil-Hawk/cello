// Ask Cello is Chat now. Old links and bookmarks forward on, carrying a typed question when there is one.

import { redirect } from 'next/navigation'

export default function AskPage({ searchParams }: { searchParams: { ask?: string } }) {
  redirect(searchParams.ask ? `/chat?ask=${encodeURIComponent(searchParams.ask)}` : '/chat')
}
