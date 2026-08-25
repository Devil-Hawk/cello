// POST /api/contacts/source — source PLAUSIBLE contacts for a tracked company
// (optionally scoped to one job posting) and persist them to public.contacts
// with full provenance (source/confidence/verified/basis on every candidate).
//
// FREE PATH WORKS WITH NO KEYS: the company dossier + job-posting text + this
// user's own already-known contacts (used only to learn an email-address
// pattern, never fabricated from nothing). Hunter.io / Apollo.io are pure
// opt-in BYOK enhancements read from profiles.preferences.api_keys — with no
// key configured they are silently skipped, never an error. See
// lib/contacts/sources.ts for the full design.
//
// SAFETY: this route only ever creates/reads `contacts` rows. It NEVER sends
// an email and exposes no send path — turning a sourced contact into an
// actual outreach message stays a separate, human-gated flow (see
// app/api/outreach/*, owned by another workstream; sending itself requires an
// explicit approve step there).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { sourceContactsForCompany } from '@/lib/contacts/sources'
import { readContactProviderKeys } from '@/lib/contacts/keys'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const BodySchema = z.object({
  companyId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(25).optional(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid JSON body' }, { status: 400 })
  }

  const admin = createAdminClient()
  const providerKeys = await readContactProviderKeys(admin, user.id)

  try {
    const result = await sourceContactsForCompany({
      client: admin,
      userId: user.id,
      companyId: body.companyId,
      jobId: body.jobId ?? null,
      hunterKey: providerKeys.hunter,
      apolloKey: providerKeys.apollo,
      limit: body.limit,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Contact sourcing failed'
    const status = /not found/i.test(message) ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
