// The Confirm card under an answer. There is no DOM renderer in this repo, so the card is a view of its state
// (markup tests) and one function that does the sending (fetch mocked).

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmCardView, decide } from './confirm-card'

const card = 'Run "send_note" on notes with: to: ana@example.com; text: Hello'
const text = (s: string) => s.replace(/<!-- -->/g, '')
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('ConfirmCardView', () => {
  it('shows the card as plain text with Confirm and Not now, each at least 44px', () => {
    const out = text(renderToStaticMarkup(<ConfirmCardView card={card} sending={null} refusal={null} onDecide={() => undefined} />))
    expect(out).toContain('Run &quot;send_note&quot; on notes with: to: ana@example.com; text: Hello')
    expect(out).toContain('>Confirm<')
    expect(out).toContain('>Not now<')
    expect(out.match(/min-h-11 min-w-11/g)?.length).toBe(2)
    expect(out).toContain('focus-visible:')
    expect(out).not.toContain('disabled=""')
  })

  it('does not turn the card into markup', () => {
    const out = renderToStaticMarkup(<ConfirmCardView card={'Run "x" on y with: a: <img src=x onerror=1>'} sending={null} refusal={null} onDecide={() => undefined} />)
    expect(out).not.toContain('<img')
  })

  it('disables both keys while sending and names the pressed one', () => {
    const a = text(renderToStaticMarkup(<ConfirmCardView card={card} sending="confirm" refusal={null} onDecide={() => undefined} />))
    expect(a).toContain('>Confirming<')
    expect(a).toContain('>Not now<')
    expect(a.match(/disabled=""/g)?.length).toBe(2)
    const b = text(renderToStaticMarkup(<ConfirmCardView card={card} sending="dismiss" refusal={null} onDecide={() => undefined} />))
    expect(b).toContain('>Dismissing<')
    expect(b).toContain('>Confirm<')
  })

  it('shows a refusal with its fix and keeps both keys', () => {
    const out = text(renderToStaticMarkup(<ConfirmCardView card={card} sending={null} refusal={{ message: 'You marked that tool Never.', fix: 'Change it in Settings, under Your own tools.' }} onDecide={() => undefined} />))
    expect(out).toContain('role="alert"')
    expect(out).toContain('You marked that tool Never.')
    expect(out).toContain('Change it in Settings, under Your own tools.')
    expect(out).toContain('>Confirm<')
    expect(out).toContain('>Not now<')
    expect(out).not.toContain('disabled=""')
  })
})

describe('decide', () => {
  it('posts confirm to the proposal and calls onDecided on ok', async () => {
    const f = reply(200, { ok: true })
    const done = vi.fn()
    expect(await decide('c1', 'p 1', 'confirm', done, f)).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/chat/c1/proposals/p%201')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'confirm' })
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('posts dismiss for Not now', async () => {
    const f = reply(200, { ok: true })
    await decide('c1', 'p1', 'dismiss', vi.fn(), f)
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ decision: 'dismiss' })
  })

  it('gives back the route\'s message and fix on a 409 and does not call onDecided', async () => {
    const f = reply(409, { error: 'refused', message: 'That server is not connected any more.', fix: 'Add it again in Settings, under Your own tools.' })
    const done = vi.fn()
    expect(await decide('c1', 'p1', 'confirm', done, f)).toEqual({ message: 'That server is not connected any more.', fix: 'Add it again in Settings, under Your own tools.' })
    expect(done).not.toHaveBeenCalled()
  })

  it('says what to do when the request never arrives or the answer is unreadable', async () => {
    const gone = vi.fn(async () => {
      throw new Error('offline')
    })
    const a = await decide('c1', 'p1', 'confirm', vi.fn(), gone)
    expect(a?.message).toBeTruthy()
    expect(a?.fix).toBeTruthy()
    const b = await decide('c1', 'p1', 'confirm', vi.fn(), vi.fn(async () => new Response('<html>', { status: 502 })))
    expect(b?.message).toBeTruthy()
    expect(b?.fix).toBeTruthy()
  })
})
