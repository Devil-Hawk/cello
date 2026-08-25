// "apify" connector — BYOK. Runs a user-configured Apify actor on the USER'S
// OWN Apify account (billed to them) via the existing lib/apify/client.ts, and
// indexes each dataset item as one kb_document.
//
// THIS IS THE CONNECTOR THAT CAN REACH LINKEDIN, AND CELLO DOES NOT DO THAT
// SCRAPING ITSELF: Cello only calls the actor id the user typed in, on the
// user's own Apify account, with the user's own token. LinkedIn's Terms of
// Service restrict automated scraping of its site — running a LinkedIn actor
// through this connector is entirely the user's own choice and their own
// account's risk, not something Cello performs on their behalf. The exact
// disclosure text shown in the UI lives in components/settings/sources-tab.tsx
// (a persistent callout, never a tooltip).
//
// OFF BY DEFAULT: kb_sources.enabled is forced false for apify sources at
// creation (see app/api/kb/sources/route.ts), and syncApifySource() refuses to
// run — cleanly, as a `disabled` outcome, never a thrown error — until BOTH
// the source is explicitly re-enabled AND a token is configured. Either gap
// alone is enough to refuse.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, isEncrypted } from '@/lib/crypto'
import { runApifyActor } from '@/lib/apify/client'
import { ApifyError, type ApifyDatasetItem } from '@/lib/apify/types'
import { upsertDocument } from '../store'
import type { KbSource } from '../types'
import type { KbSyncOutcome } from './types'

/** Max dataset items turned into documents in one sync — keeps one sync call
 *  (and the Postgres round trips it makes) bounded even for a huge actor run. */
const MAX_ITEMS_INDEXED = 200

/**
 * Read the user's own Apify token from profiles.preferences.api_keys.apify —
 * the same encrypted-JSON-blob slot as 'hunter' and the LLM provider keys
 * (see lib/outreach/config.ts for the precedent). Returns undefined (never
 * throws) when absent or corrupt — callers treat that as "not configured".
 */
export async function getApifyToken(client: SupabaseClient, userId: string): Promise<string | undefined> {
  const { data } = await client.from('profiles').select('preferences').eq('id', userId).single()
  const preferences = ((data?.preferences as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as Record<string, unknown>
  const raw = apiKeys.apify
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return isEncrypted(raw) ? decrypt(raw) : raw
  } catch {
    return undefined
  }
}

/** Best-effort text extraction from an actor-specific dataset item — actor
 *  output shapes vary wildly, so this tries common "article-like" field names
 *  first and falls back to a pretty-printed JSON blob so nothing is silently
 *  dropped. */
function itemToText(item: ApifyDatasetItem): string {
  for (const key of ['text', 'markdown', 'content', 'bodyText', 'description', 'summary']) {
    const v = item[key]
    if (typeof v === 'string' && v.trim().length > 40) return v.trim()
  }
  return JSON.stringify(item, null, 2)
}

function itemToTitle(item: ApifyDatasetItem, index: number): string {
  for (const key of ['title', 'name', 'headline', 'fullName']) {
    const v = item[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const url = item.url
  if (typeof url === 'string' && url) return url
  return `Item ${index + 1}`
}

function itemToUrl(item: ApifyDatasetItem): string | null {
  const v = item.url
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function itemToExternalId(item: ApifyDatasetItem, runId: string, index: number): string {
  for (const key of ['id', 'url']) {
    const v = item[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return `${runId}-${index}`
}

export async function syncApifySource(
  client: SupabaseClient,
  userId: string,
  source: KbSource,
  token: string | undefined
): Promise<KbSyncOutcome> {
  if (!source.enabled) {
    return {
      status: 'disabled',
      message:
        'This Apify source is disabled. Turn it on in Settings → Sources to run it — Apify runs bill your own Apify account.',
    }
  }
  if (!token) {
    return {
      status: 'disabled',
      message: 'No Apify API token configured. Add your own token in Settings → Sources — Cello never bundles one.',
    }
  }
  const actorId = typeof source.config?.actorId === 'string' ? source.config.actorId.trim() : ''
  if (!actorId) {
    return { status: 'disabled', message: 'No actor id configured for this source yet.' }
  }
  const input =
    source.config?.input && typeof source.config.input === 'object'
      ? (source.config.input as Record<string, unknown>)
      : undefined

  try {
    const run = await runApifyActor({ actorId, token, input, itemLimit: MAX_ITEMS_INDEXED })
    const items = run.items.slice(0, MAX_ITEMS_INDEXED)
    if (items.length === 0) {
      return {
        status: 'synced',
        documentsWritten: 0,
        chunksWritten: 0,
        message: `Apify run ${run.runId} succeeded but returned no dataset items.`,
      }
    }

    let documentsWritten = 0
    let chunksWritten = 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const content = itemToText(item)
      if (!content.trim()) continue
      const { chunkCount } = await upsertDocument(client, {
        userId,
        sourceId: source.id,
        externalId: itemToExternalId(item, run.runId, i),
        title: itemToTitle(item, i),
        url: itemToUrl(item),
        content,
        metadata: { apifyRunId: run.runId, apifyActorId: actorId },
      })
      documentsWritten += 1
      chunksWritten += chunkCount
    }

    return {
      status: 'synced',
      documentsWritten,
      chunksWritten,
      message: `Apify run ${run.runId}: indexed ${documentsWritten} of ${items.length} item${items.length === 1 ? '' : 's'} (${chunksWritten} chunks).`,
    }
  } catch (e) {
    if (e instanceof ApifyError) return { status: 'error', message: e.message }
    return { status: 'error', message: e instanceof Error ? e.message : 'Apify sync failed' }
  }
}
