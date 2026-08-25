// "paste" connector — index text the user pastes directly.
//
// No network calls, no keys, no external dependency: this is the connector
// that ALWAYS works, even on an account with zero API keys configured. A
// paste kb_source is a plain container — indexPasteDocument() adds (or, given
// documentId, updates) ONE document under it, so a user can paste several
// notes into the same source over time. There is no "sync" in the upstream
// sense (nothing to re-fetch); see app/api/kb/sources/[id]/documents/route.ts
// for the route that calls this directly from the Sources UI.

import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertDocument } from '../store'
import type { KbSource } from '../types'
import type { KbSyncOutcome } from './types'

export interface PasteInput {
  /** Pasted text. Required and must be non-whitespace. */
  content: string
  title?: string | null
  /** Set to update an existing pasted document instead of adding a new one. */
  documentId?: string
}

/** Chunk + index one pasted document under `source`. Always local — there is
 *  no upstream to poll, so this never times out and never needs a key. */
export async function indexPasteDocument(
  client: SupabaseClient,
  userId: string,
  source: KbSource,
  input: PasteInput
): Promise<KbSyncOutcome> {
  const content = input.content?.trim()
  if (!content) return { status: 'error', message: 'Pasted text is empty — nothing to index.' }

  try {
    const { chunkCount } = await upsertDocument(client, {
      userId,
      sourceId: source.id,
      documentId: input.documentId,
      title: input.title?.trim() || null,
      content,
    })

    return {
      status: 'synced',
      documentsWritten: 1,
      chunksWritten: chunkCount,
      message: `Indexed ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} from pasted text.`,
    }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Failed to index pasted text' }
  }
}
