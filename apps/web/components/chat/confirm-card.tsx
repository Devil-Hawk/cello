'use client'

// A call Cello wants to make on one of the person's own servers, waiting for their word. The card is the sentence code
// wrote from the stored call (lib/chat/proposals.ts), shown as plain text and never as markup. Confirm is the person's
// own click; nothing was sent before it. Type-only imports from lib, so this file stands alone.

import { useState } from 'react'

export interface OpenProposal {
  id: string
  card: string
  turnId: string | null
  answerId: string | null
}

type Decision = 'confirm' | 'dismiss'
export interface Refusal {
  message: string
  fix: string
}

/** Posts the person's decision. null when it went through (onDecided has been called); a refusal in plain words otherwise. */
export async function decide(chatId: string, id: string, decision: Decision, onDecided: () => void, f: typeof fetch = fetch): Promise<Refusal | null> {
  try {
    const res = await f(`/api/chat/${encodeURIComponent(chatId)}/proposals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    if (res.ok) {
      onDecided()
      return null
    }
    const body = (await res.json().catch(() => null)) as { message?: unknown; fix?: unknown } | null
    if (typeof body?.message === 'string' && body.message) return { message: body.message, fix: typeof body.fix === 'string' ? body.fix : 'Try again.' }
  } catch {
    // falls through to the plain sentence
  }
  return { message: 'Cello could not send that.', fix: 'Check your connection and try again.' }
}

const BUTTON =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-card px-3 py-1 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40'

export function ConfirmCardView({ card, sending, refusal, onDecide }: { card: string; sending: Decision | null; refusal: Refusal | null; onDecide: (d: Decision) => void }) {
  return (
    <div className="space-y-2 rounded-card border border-border bg-card p-3 text-body text-foreground" data-confirm-card>
      <p className="whitespace-pre-wrap break-words">{card}</p>
      <div className="flex flex-wrap gap-2 text-caption">
        <button type="button" className={BUTTON} disabled={sending !== null} onClick={() => onDecide('confirm')}>
          {sending === 'confirm' ? 'Confirming' : 'Confirm'}
        </button>
        <button type="button" className={BUTTON} disabled={sending !== null} onClick={() => onDecide('dismiss')}>
          {sending === 'dismiss' ? 'Dismissing' : 'Not now'}
        </button>
      </div>
      {refusal && (
        <p role="alert" className="text-caption text-muted-foreground">
          <span className="text-foreground">{refusal.message}</span> {refusal.fix}
        </p>
      )}
    </div>
  )
}

export function ConfirmCard({ chatId, proposal, onDecided }: { chatId: string; proposal: OpenProposal; onDecided: () => void }) {
  const [sending, setSending] = useState<Decision | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  async function onDecide(d: Decision) {
    setSending(d)
    setRefusal(null)
    setRefusal(await decide(chatId, proposal.id, d, onDecided))
    setSending(null)
  }
  return <ConfirmCardView card={proposal.card} sending={sending} refusal={refusal} onDecide={(d) => void onDecide(d)} />
}
