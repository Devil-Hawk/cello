// Thin Gmail REST helpers: fetch/parse messages. No Supabase/DB concerns here.

import type { GmailMessage } from './types'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

/**
 * Search query for job-application-related email. Tightened from the old
 * broad `OR from:(... OR noreply)` (which matched almost anything) to
 * require an actual job-application signal in the subject, or a
 * careers/recruiting-looking sender paired with an application-shaped
 * subject — and excludes bulk mail categories.
 */
export const JOB_EMAIL_QUERY = [
  '(',
  'subject:(application OR "thank you for applying" OR "thanks for applying" OR "we received your application"',
  'OR "your application" OR "application status" OR interview OR "phone screen" OR onsite OR "next steps"',
  'OR offer OR "job offer" OR rejected OR "not moving forward" OR "moved forward with other")',
  'OR',
  '(from:(careers OR recruiting OR talent OR jobs OR hr OR hiring) subject:(application OR interview OR position OR role OR candidate OR offer))',
  ')',
  '-category:promotions -category:social -category:forums',
  '-subject:(newsletter OR digest OR unsubscribe OR webinar OR "% off" OR sale)',
].join(' ')

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return Buffer.from(base64, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

export function extractBody(payload: GmailMessage['payload']): string {
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
    for (const part of payload.parts) {
      if (part.body?.data) return decodeBase64Url(part.body.data)
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data)
  return ''
}

export function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return header?.value || ''
}

export function extractDomain(email: string): string | null {
  const match = email.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  return match ? match[1].toLowerCase() : null
}

export async function fetchGmailMessages(
  accessToken: string,
  query: string,
  maxResults = 500
): Promise<GmailMessage[]> {
  const allMessageIds: Array<{ id: string }> = []
  let pageToken: string | undefined

  while (allMessageIds.length < maxResults) {
    const searchUrl = `${GMAIL_API}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, maxResults - allMessageIds.length)}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!searchResponse.ok) {
      const error = await searchResponse.text()
      throw new Error(`Gmail search failed: ${error}`)
    }

    const searchData = await searchResponse.json()
    const messageIds = searchData.messages || []
    allMessageIds.push(...messageIds)

    pageToken = searchData.nextPageToken
    if (!pageToken) break
  }

  const messages: GmailMessage[] = []
  const batchSize = 10

  for (let i = 0; i < Math.min(allMessageIds.length, maxResults); i += batchSize) {
    const batch = allMessageIds.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(async ({ id }) => {
        const msgUrl = `${GMAIL_API}/users/me/messages/${id}?format=full`
        const msgResponse = await fetch(msgUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (msgResponse.ok) return msgResponse.json()
        return null
      })
    )
    messages.push(...batchResults.filter((m): m is GmailMessage => m !== null))
  }

  return messages
}
