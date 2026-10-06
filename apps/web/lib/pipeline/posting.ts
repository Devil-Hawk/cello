// One address, one hash. The host without www, the path without a trailing slash, lower case; the
// query and the fragment dropped, except a Greenhouse job id, which is what tells two postings on one
// company page apart. The send block reads it, so a posting that was sent once is the same posting
// whatever tracking the link carries.
//
// public.posting_url_hash (migration 20261013000002) is the same function in SQL; posting.test.ts and
// supabase/checks/pipeline_core.sql pin both to the same three values.

import { createHash } from 'node:crypto'

export function normalizePostingUrl(url: string): string | null {
  const raw = url.trim()
  if (!raw) return null
  const noQuery = raw.replace(/[?#].*$/, '')
  const path = noQuery.replace(/^[a-zA-Z]+:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase()
  const jid = /[?&]gh_jid=([0-9]+)/.exec(raw)?.[1]
  return path + (jid ? `?gh_jid=${jid}` : '')
}

export function postingUrlHash(url: string): string | null {
  const n = normalizePostingUrl(url)
  return n === null ? null : createHash('sha256').update(n, 'utf8').digest('hex')
}
