// POST /api/applications/attempts — log an application attempt WITHOUT
// email. This is the "I already applied" fast path: date, resume used,
// where you applied, current status, plus an optional confirmation note or
// screenshot. See lib/applications/attempt-rules.ts's header for the "seconds,
// not CRM data entry" constraint every validation rule here respects.
//
// GET /api/applications/attempts?applicationId=<uuid> — every attempt on
// file for one application, plus the honest inbox-monitoring notice (see
// buildMonitoringNotice) so the UI can say plainly whether Cello can
// auto-detect a reply here or not.
//
// PROVENANCE INTEGRITY: this route is the ONLY writer reachable from a
// normal authenticated request, and it always forces provenance='manual' /
// verification_state='user_confirmed' — a request body can never smuggle a
// stronger claim (e.g. "system_confirmed") than "the applicant asserts
// this". lib/ats-apply's own submission path (app/api/drafts/approve) is a
// separate, privileged writer that would call
// lib/applications/attempts.ts#createAttempt directly with provenance:
// 'ats_direct' — not through this HTTP surface. That wiring is a follow-up;
// this route and the underlying table already accept it without a
// migration.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import {
  createAttempt,
  getOwnedApplication,
  listAttempts,
  syncApplicationFromAttempt,
} from '@/lib/applications/attempts'
import { buildApplicationStatusMessage, buildMonitoringNotice, validateNewAttempt } from '@/lib/applications/attempt-rules'
import type { NewAttemptInput, AttemptDocument } from '@/lib/applications/types'

export const dynamic = 'force-dynamic'

function bad(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status })
}

async function monitoringForUser(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data: profile } = await admin.from('profiles').select('preferences').eq('id', userId).single()
  return buildMonitoringNotice(hasGmailPermission(profile?.preferences ?? null, 'monitor'))
}

function parseDocuments(raw: unknown): AttemptDocument[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => ({
      kind: d.kind === 'cover_letter' || d.kind === 'other' ? d.kind : 'resume',
      label: typeof d.label === 'string' ? d.label : '',
      resumeDocumentId: typeof d.resumeDocumentId === 'string' ? d.resumeDocumentId : null,
    }))
}

function parseBody(body: unknown): Partial<NewAttemptInput> {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    applicationId: typeof b.applicationId === 'string' ? b.applicationId : undefined,
    submittedAt: typeof b.submittedAt === 'string' ? b.submittedAt : undefined,
    destination: typeof b.destination === 'string' ? b.destination : undefined,
    documents: parseDocuments(b.documents),
    confirmationIdentifier: typeof b.confirmationIdentifier === 'string' ? b.confirmationIdentifier : null,
    confirmationNote: typeof b.confirmationNote === 'string' ? b.confirmationNote : null,
    confirmationAttachmentUrl: typeof b.confirmationAttachmentUrl === 'string' ? b.confirmationAttachmentUrl : null,
    stage: typeof b.stage === 'string' ? b.stage : null,
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return bad('Invalid JSON body')
  }

  const input = parseBody(body)
  const validation = validateNewAttempt(input)
  if (!validation.ok) return bad('Invalid attempt', 400, { errors: validation.errors })

  // Runtime-validated above, so this narrowing is sound even though the
  // static type of `input` is Partial<NewAttemptInput>.
  const validated = input as NewAttemptInput
  const admin = createAdminClient()

  const application = await getOwnedApplication(admin, user.id, validated.applicationId)
  if (!application) return bad('Application not found', 404)

  const attempt = await createAttempt(
    admin,
    user.id,
    validated,
    // Forced, never trusted from the request body — see this file's header.
    'manual',
    'user_confirmed',
    application
  )

  await syncApplicationFromAttempt(admin, user.id, application, attempt, input.stage)

  const monitoring = await monitoringForUser(admin, user.id)

  return NextResponse.json(
    {
      attempt,
      monitoring,
      statusMessage: buildApplicationStatusMessage(attempt, monitoring),
    },
    { status: 201 }
  )
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  const applicationId = request.nextUrl.searchParams.get('applicationId')
  if (!applicationId) return bad('applicationId is required')

  const admin = createAdminClient()

  const application = await getOwnedApplication(admin, user.id, applicationId)
  if (!application) return bad('Application not found', 404)

  const attempts = await listAttempts(admin, user.id, applicationId)
  const monitoring = await monitoringForUser(admin, user.id)
  const latest = attempts[0] ?? null

  return NextResponse.json({
    attempts,
    monitoring,
    statusMessage: buildApplicationStatusMessage(latest, monitoring),
  })
}
