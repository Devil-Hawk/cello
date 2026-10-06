// The one door to the person's own inbox: a message from their own Gmail to their own address, and to
// no one else. The recipient is read from the account, never passed in. Needs the Gmail send grant;
// without it nothing goes out and the caller is told.
//
// ponytail: stands in for K10's sendToSelf (lib/commands/send-to-self.ts) until it is on main.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getGmailAccessToken } from '@/lib/gmail/token'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { sendGmailMessage } from '@/lib/outreach/gmail'
import type { MailResult } from './deliver'

export function selfMailer(admin: SupabaseClient) {
  return async (userId: string, subject: string, text: string): Promise<MailResult> => {
    const { data } = await admin.from('profiles').select('email, full_name, preferences').eq('id', userId).maybeSingle()
    const p = data as { email: string | null; full_name: string | null; preferences: Record<string, unknown> | null } | null
    if (!p?.email) return 'failed'
    const preferences = p.preferences ?? {}
    if (!hasGmailPermission(preferences, 'send')) return 'no_scope'
    const token = await getGmailAccessToken(admin, userId, preferences)
    if (!token.ok) return 'no_scope'
    try {
      const name = p.full_name || p.email.split('@')[0]
      await sendGmailMessage({ accessToken: token.accessToken, toEmail: p.email, toName: name, fromName: 'Cello', fromEmail: p.email, subject, body: text })
      return 'sent'
    } catch {
      return 'failed'
    }
  }
}
