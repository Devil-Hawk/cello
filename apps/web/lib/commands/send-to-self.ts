// sendToSelf: mail the person's own address, and nobody else's.
//
// The daily summary is the only thing that uses it (K20's summary.send). There
// is no `to` parameter on purpose: the recipient is read from the sign-in record
// of ctx.userId, so no argument, template or model-written text can name another
// address. It sends through the person's own Gmail connection, From and To the
// same address. A person without Gmail send turned on gets no mail, not a
// fallback to some other sender.

import type { CommandContext } from './define'

export type SendToSelfResult = { ok: true; to: string } | { ok: false; reason: string }

export interface SendToSelfDeps {
  /** The address on the person's sign-in record. */
  emailFor(ctx: CommandContext): Promise<string>
  /** A Gmail access token for the person, or null when send is not available. */
  tokenFor(ctx: CommandContext): Promise<string | null>
  send(input: { accessToken: string; toEmail: string; fromEmail: string; subject: string; body: string }): Promise<void>
}

const defaultDeps: SendToSelfDeps = {
  async emailFor(ctx) {
    const { data } = await ctx.admin().auth.admin.getUserById(ctx.userId)
    return typeof data?.user?.email === 'string' ? data.user.email : ''
  },
  async tokenFor(ctx) {
    const [{ readProfileForDemoGuards }, { hasGmailPermission }, { resolveGmailAccessToken }, { demoSendGate }] = await Promise.all([
      import('@/lib/harness/keys'),
      import('@/lib/gmail/permissions'),
      import('@/lib/gmail/token'),
      import('@/lib/access/guardrails'),
    ])
    const admin = ctx.admin()
    const { row } = await readProfileForDemoGuards(admin, ctx.userId)
    // A demo never delivers mail, not even to its own address.
    if (!row || !demoSendGate({ is_demo: row.is_demo ?? null, demo_expires_at: row.demo_expires_at ?? null }).allowed || !hasGmailPermission(row.preferences, 'send')) return null
    const token = await resolveGmailAccessToken(admin, ctx.userId, (row.preferences ?? {}) as Record<string, unknown>, undefined)
    return token.ok ? token.accessToken : null
  },
  async send(input) {
    const { sendGmailMessage } = await import('@/lib/outreach/gmail')
    await sendGmailMessage({
      accessToken: input.accessToken,
      toEmail: input.toEmail,
      toName: null,
      fromName: 'Cello',
      fromEmail: input.fromEmail,
      subject: input.subject,
      body: input.body,
      threadId: null,
    })
  },
}

/** A header value never carries a line break. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export async function sendToSelf(
  ctx: CommandContext,
  input: { subject: string; body: string },
  deps: SendToSelfDeps = defaultDeps
): Promise<SendToSelfResult> {
  const to = await deps.emailFor(ctx)
  if (!to) return { ok: false, reason: 'There is no address on this account to send to.' }
  const accessToken = await deps.tokenFor(ctx)
  if (!accessToken) return { ok: false, reason: 'Sending through Gmail is not turned on.' }
  await deps.send({ accessToken, toEmail: to, fromEmail: to, subject: oneLine(input.subject), body: input.body })
  return { ok: true, to }
}
