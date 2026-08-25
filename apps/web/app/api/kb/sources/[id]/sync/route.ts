// POST /api/kb/sources/[id]/sync — run one connector's sync now.
//
// Every call records the outcome via recordSync(): last_synced_at on success,
// last_error otherwise (covers BOTH `disabled` and `error` outcomes) — so a
// source that couldn't sync keeps saying why in the UI even after a reload,
// instead of quietly looking untouched. The HTTP status is always 200 for a
// well-formed, authorized request; `ok`/`status` in the body is what the
// client branches on — a disabled/misconfigured connector (e.g. an Apify
// source with no token yet) is an expected, clearly-labeled state, not a
// server error.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { getSource, listDocuments, recordSync } from '@/lib/kb/store'
import { getApifyToken, syncApifySource } from '@/lib/kb/connectors/apify'
import { syncResumeSource } from '@/lib/kb/connectors/resume'
import { syncUrlSource } from '@/lib/kb/connectors/url'
import type { KbSyncOutcome } from '@/lib/kb/connectors/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const source = await getSource(admin, user.id, params.id)
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let outcome: KbSyncOutcome
  switch (source.kind) {
    case 'resume':
      outcome = await syncResumeSource(admin, user.id, source)
      break
    case 'url':
      outcome = await syncUrlSource(admin, user.id, source)
      break
    case 'apify': {
      const token = await getApifyToken(admin, user.id)
      outcome = await syncApifySource(admin, user.id, source, token)
      break
    }
    case 'paste': {
      // Nothing to fetch — paste sources are populated via
      // POST .../documents. Report current state rather than erroring, so
      // "Sync" is never a dead end even for a connector kind with no
      // upstream to pull from.
      const docs = await listDocuments(admin, user.id, { sourceId: source.id, limit: 1 })
      outcome =
        docs.length > 0
          ? {
              status: 'synced',
              documentsWritten: 0,
              chunksWritten: 0,
              message: 'Paste sources are indexed as you add text — nothing new to fetch.',
            }
          : { status: 'disabled', message: 'No text pasted yet — add a document to this source first.' }
      break
    }
    default:
      outcome = { status: 'error', message: `No sync connector implemented for "${source.kind}" yet.` }
  }

  try {
    if (outcome.status === 'synced') {
      await recordSync(admin, user.id, source.id)
    } else {
      await recordSync(admin, user.id, source.id, outcome.message)
    }
  } catch (e) {
    // Recording the outcome failing is itself worth logging, but must not
    // mask the sync outcome the caller actually asked about.
    console.error('[kb/sources/sync] recordSync failed:', e)
  }

  return NextResponse.json({ ok: outcome.status === 'synced', ...outcome })
}
