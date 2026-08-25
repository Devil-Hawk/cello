// "resume" connector — reindex the user's own resume text (profiles.resume_text)
// into the knowledge base.
//
// No network calls, no keys — same "always works" tier as paste. A resume
// already lives in Cello; this connector just makes it retrievable through the
// same search_kb path as every other source instead of a bespoke lookup, so
// the copilot can cite "your resume says X" alongside pasted notes, indexed
// pages, and Apify results.

import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertDocument } from '../store'
import type { KbSource } from '../types'
import type { KbSyncOutcome } from './types'

/** Stable external_id so re-syncing always updates the SAME document instead
 *  of piling up a new one every time the resume changes. */
const RESUME_EXTERNAL_ID = 'resume-text'

export async function syncResumeSource(
  client: SupabaseClient,
  userId: string,
  source: KbSource
): Promise<KbSyncOutcome> {
  try {
    const { data, error } = await client
      .from('profiles')
      .select('resume_text, full_name')
      .eq('id', userId)
      .single()
    if (error) return { status: 'error', message: `Could not read your profile: ${error.message}` }

    const row = data as { resume_text?: string | null; full_name?: string | null } | null
    const resumeText = String(row?.resume_text ?? '').trim()
    if (!resumeText) {
      return {
        status: 'disabled',
        message: 'No resume on file yet — upload one in Settings → Profile, then sync again.',
      }
    }

    const title = row?.full_name ? `${row.full_name} — resume` : 'Resume'
    const { chunkCount } = await upsertDocument(client, {
      userId,
      sourceId: source.id,
      externalId: RESUME_EXTERNAL_ID,
      title,
      content: resumeText,
    })

    return {
      status: 'synced',
      documentsWritten: 1,
      chunksWritten: chunkCount,
      message: `Indexed ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} from your resume.`,
    }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Resume sync failed' }
  }
}
