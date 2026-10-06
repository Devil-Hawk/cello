// sendToSelf: the recipient is the address on the sign-in record, whatever the
// caller passes.

import { describe, expect, it, vi } from 'vitest'
import { sendToSelf, type SendToSelfDeps } from './send-to-self'
import { chatDoor } from './doors'

function deps(over: Partial<SendToSelfDeps> = {}) {
  const send = vi.fn(async (_input: Parameters<SendToSelfDeps['send']>[0]) => {})
  const d: SendToSelfDeps = {
    emailFor: async () => 'me@example.com',
    tokenFor: async () => 'token',
    send,
    ...over,
  }
  return { d, send }
}

const ctx = chatDoor({ userId: 'user-1' })

describe('sendToSelf', () => {
  it('sends to the auth email and ignores any address in the input', async () => {
    const { d, send } = deps()
    const forged = { subject: 'Today', body: 'Hello', to: 'victim@example.com', toEmail: 'victim@example.com' } as { subject: string; body: string }
    await expect(sendToSelf(ctx, forged, d)).resolves.toEqual({ ok: true, to: 'me@example.com' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ toEmail: 'me@example.com', fromEmail: 'me@example.com' })
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain('victim')
  })

  it('keeps a line break out of the subject', async () => {
    const { d, send } = deps()
    await sendToSelf(ctx, { subject: 'Today\r\nBcc: victim@example.com', body: 'Hello' }, d)
    expect(send.mock.calls[0][0].subject).toBe('Today Bcc: victim@example.com')
  })

  it('sends nothing when the account has no address or Gmail send is off', async () => {
    const none = deps({ emailFor: async () => '' })
    await expect(sendToSelf(ctx, { subject: 's', body: 'b' }, none.d)).resolves.toMatchObject({ ok: false })
    expect(none.send).not.toHaveBeenCalled()

    const off = deps({ tokenFor: async () => null })
    await expect(sendToSelf(ctx, { subject: 's', body: 'b' }, off.d)).resolves.toMatchObject({ ok: false })
    expect(off.send).not.toHaveBeenCalled()
  })
})
