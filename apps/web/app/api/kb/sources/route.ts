// GET/POST /api/kb/sources — list + create the signed-in user's knowledge-base
// connectors.
//
// Creation is deliberately conservative: only the four connector kinds this
// builder wired sync logic for (paste, url, resume, apify — see
// lib/kb/connectors/*) can be created here. The other KB_SOURCE_KINDS
// (linkedin_export, gmail, dossier) exist in the schema for future connectors
// but have no sync implementation yet, so creating one here would just
// produce a source that can never sync.
//
// apify sources are FORCED to enabled:false at creation regardless of what the
// client sends — see lib/kb/connectors/apify.ts and sources-tab.tsx for why
// (BYOK billing + LinkedIn ToS disclosure). The user must flip it on
// explicitly via PATCH after reading that disclosure in the UI.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createSource, listSources } from '@/lib/kb/store'
import { isKbSourceKind, type KbSourceConfig, type KbSourceKind } from '@/lib/kb/types'

export const dynamic = 'force-dynamic'

/** Kinds this route accepts at creation — the ones with a real sync connector. */
const CREATABLE_KINDS = new Set<KbSourceKind>(['paste', 'url', 'resume', 'apify'])

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  try {
    const sources = await listSources(admin, user.id)
    return NextResponse.json({ ok: true, sources })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to list sources' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = (body || {}) as Record<string, unknown>
  const kind = b.kind
  if (!isKbSourceKind(kind)) {
    return NextResponse.json({ error: 'Invalid or missing "kind"' }, { status: 400 })
  }
  if (!CREATABLE_KINDS.has(kind)) {
    return NextResponse.json({ error: `"${kind}" sources are not supported here yet.` }, { status: 400 })
  }

  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 200) : null
  const config = (b.config && typeof b.config === 'object' ? b.config : null) as KbSourceConfig | null

  // apify is off by default no matter what the client asked for — the user
  // must flip it on explicitly (PATCH) after seeing the BYOK/LinkedIn notice.
  const enabled = kind === 'apify' ? false : b.enabled !== false

  const admin = createAdminClient()
  try {
    const source = await createSource(admin, { userId: user.id, kind, label, config, enabled })
    return NextResponse.json({ ok: true, source })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create source' }, { status: 500 })
  }
}
